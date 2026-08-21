#!/usr/bin/env bash
#
# Install KeeperHub on a self-hosted Kubernetes cluster.
#
# This is a convenience wrapper, not a requirement. The values files beside it
# are ordinary Helm input, so a plain `helm install -f values.yaml ...` works and
# the README documents that path. What this adds is the checks helm cannot make:
# it refuses to guess a cluster, it verifies the prerequisites a failed render
# would otherwise report as a rollback, and it says which optional runner
# credentials are missing before you discover it from a workflow that ran and
# did nothing.
#
# Usage:
#   KUBE_CONTEXT=<ctx> IMAGE_REPO=<registry> IMAGE_TAG=<tag> APP_HOST=<host> ./install.sh
#
# You bring: a cluster with a default StorageClass, an ingress controller,
# container images the cluster can pull, a cert-manager ClusterIssuer if you
# want TLS, and the CloudNativePG operator if you want the chart to run
# PostgreSQL. See config.sh for every setting and README.md for the detail.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=deploy/keeperhub-stack/self-hosted/config.sh
. "$SCRIPT_DIR/config.sh"

# The repository .env, if there is one, read through the same quote-safe loader
# and AFTER ENV_FILE so it can only fill gaps.
#
# It used to be sourced with `set -a; . file`, which strips quotes from every
# value it reads. A JSON setting such as CHAIN_RPC_CONFIG does not survive that,
# and the damage is invisible: the value parses as empty and the install falls
# back to defaults rather than failing.
#
# Guarded by the caller rather than by `|| true`. load_env_file exits on a file
# it was told to read and cannot find, which is right for ENV_FILE and wrong
# here, and an `exit` inside a function ends the script no matter what follows
# it on the line. The symptom was a silent exit 1 with no output at all.
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
if [ -f "$REPO_ROOT/.env" ]; then
    load_env_file "$REPO_ROOT/.env"
fi

DRY_RUN=false
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=true ;;
        --help|-h) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown option: $arg" >&2; exit 1 ;;
    esac
done

# Under --dry-run stdout is the rendered manifest, so progress goes to stderr.
section() { if [ "$DRY_RUN" = true ]; then echo "==> $*" >&2; else echo "==> $*"; fi; }
ok()      { if [ "$DRY_RUN" = true ]; then echo "    $*" >&2;  else echo "    $*"; fi; }
warn()    { echo "    warning: $*" >&2; }

preflight() {
    section "Preflight"
    require_tools kubectl helm
    # Only the sandbox manifest is substituted, so envsubst is required only
    # when it is going to be applied.
    [ "$SANDBOX_ENABLED" = true ] && require_tools envsubst
    require_context
    validate_modes

    # Listed together rather than one render failure at a time. Skipped when a
    # profile overlay is merged, because the overlay supplies these itself and
    # the chart's own `required` is then the accurate check - this one would only
    # report values that are about to be set.
    #
    # The two mail settings are the exception: no chart `required` backs them,
    # so this is the only check. That is deliberate. A profile overlay builds a
    # throwaway cluster that nobody signs up on, and demanding a real SendGrid
    # account to bring one up would be a tax with nothing behind it. Every other
    # install needs mail to complete a signup, so the check is not optional
    # there.
    if [ -z "$PROFILE" ]; then
        local missing=()
        [ -n "$IMAGE_REPO" ] || missing+=("IMAGE_REPO")
        [ -n "$IMAGE_TAG" ] || missing+=("IMAGE_TAG")
        [ -n "$APP_HOST" ] || missing+=("APP_HOST")
        [ -n "$SENDGRID_API_KEY" ] || missing+=("SENDGRID_API_KEY")
        [ -n "$FROM_ADDRESS" ] || missing+=("FROM_ADDRESS")
        if [ "${#missing[@]}" -gt 0 ]; then
            echo "Required settings are not set: ${missing[*]}" >&2
            echo "See config.sh for what each one is." >&2
            exit 1
        fi
    fi

    if [ "$DB_MODE" = bundled ] && [ "$DRY_RUN" = false ]; then
        # The CRDs are cluster-scoped, so they cannot come from this release.
        # Checked rather than left to fail later: without the CRD the Cluster
        # object is rejected mid-apply and --atomic rolls the whole release back
        # with an error that names a resource kind, not a missing operator.
        if ! kube get crd clusters.postgresql.cnpg.io >/dev/null 2>&1; then
            cat >&2 <<EOF
DB_MODE=bundled needs the CloudNativePG operator, and its CRDs are not installed.

    kubectl --context $KUBE_CONTEXT apply --server-side -f \\
      https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.24/releases/cnpg-1.24.1.yaml

Or set DB_MODE=byo and supply your own database.
EOF
            exit 1
        fi
        wait_for_cnpg_webhook
    fi

    if [ "$DB_MODE" = byo ] && [ "$DRY_RUN" = false ]; then
        # The chart renders a bare secretKeyRef with no `optional`, so a missing
        # Secret is CreateContainerConfigError and --atomic rolls the whole
        # release back with a message that names the container, not the Secret.
        if ! kube_ns get secret "$DB_SECRET_NAME" >/dev/null 2>&1; then
            echo "DB_MODE=byo but Secret '$DB_SECRET_NAME' does not exist in namespace '$NAMESPACE'." >&2
            echo "Create it with key '$DB_SECRET_KEY' holding the connection string, then re-run." >&2
            exit 1
        fi
        ok "database secret $DB_SECRET_NAME present"
    fi

    # Half a key pair is always a mistake, and the SDK's failure for it is
    # opaque. Checked here rather than at first use.
    if { [ -n "$AWS_ACCESS_KEY_ID" ] && [ -z "$AWS_SECRET_ACCESS_KEY" ]; } ||
       { [ -z "$AWS_ACCESS_KEY_ID" ] && [ -n "$AWS_SECRET_ACCESS_KEY" ]; }; then
        echo "Set both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or neither." >&2
        exit 1
    fi

    ok "context $KUBE_CONTEXT, namespace $NAMESPACE, db=$DB_MODE queue=$QUEUE_MODE"
}

# Wait for the CloudNativePG admission webhook to be able to answer.
#
# The CRD exists the instant its manifest is applied, so a check for the CRD
# passes immediately and says nothing about whether the operator behind it is
# running. Applying the operator and installing straight afterwards therefore
# gets through the preflight and fails in the middle of the release:
#
#   Internal error occurred: failed calling webhook "mcluster.cnpg.io":
#   dial tcp ...:443: connect: connection refused
#
# With --atomic that rolls the whole release back, so the error names a webhook
# rather than the thing that was actually wrong, which is timing.
#
# The service is read from the webhook configuration rather than assumed, so an
# operator installed into a different namespace still works. Absent webhook
# configuration means an install that does not use one; nothing to wait for.
wait_for_cnpg_webhook() {
    local ns name addrs i
    ns=$(kube get mutatingwebhookconfiguration cnpg-mutating-webhook-configuration \
        -o jsonpath='{.webhooks[0].clientConfig.service.namespace}' 2>/dev/null || true)
    name=$(kube get mutatingwebhookconfiguration cnpg-mutating-webhook-configuration \
        -o jsonpath='{.webhooks[0].clientConfig.service.name}' 2>/dev/null || true)

    if [ -z "$name" ] || [ -z "$ns" ]; then
        ok "cloudnative-pg operator present"
        return 0
    fi

    for i in $(seq 1 60); do
        addrs=$(kube get endpoints "$name" -n "$ns" \
            -o jsonpath='{.subsets[*].addresses[*].ip}' 2>/dev/null || true)
        if [ -n "$addrs" ]; then
            ok "cloudnative-pg operator present and its webhook is serving"
            return 0
        fi
        [ "$i" = 1 ] && ok "waiting for the cloudnative-pg webhook to come up"
        sleep 2
    done

    echo "The CloudNativePG webhook ($ns/$name) has no endpoints after 2 minutes." >&2
    echo "The operator is installed but not running. Check it with:" >&2
    echo "    kubectl --context $KUBE_CONTEXT -n $ns get pods" >&2
    exit 1
}

# Create the namespace before anything is put into it.
#
# helm passes --create-namespace, but that happens at the end. The Secrets and
# the sandbox manifest go in first, so on a cluster where the namespace does not
# already exist the install stops on the first of them with
# `namespaces "keeperhub" not found` - after the preflight has reported
# everything fine.
#
# It only ever showed up on a genuinely fresh cluster. Any re-install found the
# namespace left behind by the previous one.
#
# Idempotent through apply, so an existing namespace is untouched rather than an
# error.
ensure_namespace() {
    [ "$DRY_RUN" = false ] || return 0
    kubectl --context "$KUBE_CONTEXT" create namespace "$NAMESPACE" \
        --dry-run=client -o yaml | kube apply -f - >/dev/null
    ok "namespace $NAMESPACE"
}

# Real AWS credentials for a real SQS queue. Kept out of the values files, which
# are committed and readable through `helm get values`.
create_aws_credentials_secret() {
    use_aws_credentials || return 0
    [ "$DRY_RUN" = false ] || return 0
    kube_ns create secret generic "$AWS_CREDENTIALS_SECRET" \
        --from-literal=AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
        --from-literal=AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
        --from-literal=AWS_SESSION_TOKEN="$AWS_SESSION_TOKEN" \
        --dry-run=client -o yaml | kube apply -f -
    if [ -n "$AWS_SESSION_TOKEN" ]; then
        warn "these are temporary credentials; the pods stop being able to reach SQS"
        warn "when they expire, with ExpiredToken in the logs"
    fi
    ok "aws credentials ($AWS_CREDENTIALS_SECRET)"
}

# Report which optional runner credentials are absent.
#
# This exists because their absence is invisible at runtime. The executor marks
# each of these secretKeyRefs optional, so a runner pod with none of them starts,
# runs, exits 0 and reports success while every step that needed one did nothing.
# There is no log line for it and no failed execution to find.
#
# The optionality is application behaviour and stays as it is. Naming the gap at
# install time is what this layer can do about it.
check_runner_secrets() {
    [ "$DRY_RUN" = false ] || return 0
    section "Runner credentials"

    local entry slug why name absent=()
    for entry in "${RUNNER_OPTIONAL_SECRETS[@]}"; do
        slug="${entry%%|*}"
        why="${entry#*|}"
        name="${RUNNER_SECRET_PREFIX}-${slug}"
        if ! kube_ns get secret "$name" >/dev/null 2>&1; then
            absent+=("$name|$why")
        fi
    done

    if [ "${#absent[@]}" -eq 0 ]; then
        ok "all ${#RUNNER_OPTIONAL_SECRETS[@]} optional runner credentials present"
        return 0
    fi

    echo "" >&2
    echo "  ${#absent[@]} of ${#RUNNER_OPTIONAL_SECRETS[@]} optional runner credentials are absent." >&2
    echo "  A workflow using one of these will run, exit 0 and do nothing:" >&2
    echo "" >&2
    for entry in "${absent[@]}"; do
        printf '    %-52s %s\n' "${entry%%|*}" "${entry#*|}" >&2
    done
    echo "" >&2
    echo "  Each is a Secret whose key equals its name. For example:" >&2
    echo "" >&2
    echo "    kubectl --context $KUBE_CONTEXT -n $NAMESPACE create secret generic \\" >&2
    echo "      ${RUNNER_SECRET_PREFIX}-openai-api-key \\" >&2
    echo "      --from-literal=${RUNNER_SECRET_PREFIX}-openai-api-key=<value>" >&2
    echo "" >&2

    if [ "$STRICT_RUNNER_SECRETS" = true ]; then
        echo "  STRICT_RUNNER_SECRETS=true, so this is an error." >&2
        exit 1
    fi
    echo "  Set STRICT_RUNNER_SECRETS=true to make this an error instead." >&2
}

# Compose the -f list. Order matters: base, then one db fragment, then one queue
# fragment, then the conditional extras, then the profile overlay.
#
# Composition rather than override, because a later -f cannot delete a key:
# helm's null-deletion only fires for keys present in the chart's own defaults,
# app.env is {} there, so AWS_ENDPOINT_URL: null does not remove the key - it
# crashes the subchart on a nil dereference. Omitting the key from the file that
# gets merged is the only way to express "not set".
VALUES_ARGS=()
compose_values() {
    section "Composing values"
    local composed="values.yaml + db-$DB_MODE + queue-$QUEUE_MODE"

    VALUES_ARGS+=(-f "$SCRIPT_DIR/values.yaml")
    VALUES_ARGS+=(-f "$SCRIPT_DIR/values.db-$DB_MODE.yaml")
    VALUES_ARGS+=(-f "$SCRIPT_DIR/values.queue-$QUEUE_MODE.yaml")

    # Only when an endpoint was given. Its ABSENCE is what selects real AWS SQS,
    # so this cannot be folded into values.queue-byo.yaml with an empty value.
    if [ "$QUEUE_MODE" = byo ] && [ -n "$AWS_ENDPOINT_URL" ]; then
        VALUES_ARGS+=(-f "$SCRIPT_DIR/values.queue-byo-endpoint.yaml")
        composed="$composed + queue-byo-endpoint"
    fi
    if use_aws_credentials; then
        VALUES_ARGS+=(-f "$SCRIPT_DIR/values.queue-aws-credentials.yaml")
        composed="$composed + queue-aws-credentials"
    fi
    if [ -n "$PROFILE" ]; then
        if [ ! -f "$SCRIPT_DIR/values.$PROFILE.yaml" ]; then
            echo "PROFILE=$PROFILE but values.$PROFILE.yaml does not exist." >&2
            exit 1
        fi
        VALUES_ARGS+=(-f "$SCRIPT_DIR/values.$PROFILE.yaml")
        composed="$composed + $PROFILE"
    fi
    ok "$composed"
}

# Environment overrides become --set flags on the chart's global map. Only what
# was actually set is passed, so an unset variable leaves the profile default in
# place rather than blanking it.
SET_ARGS=()
compose_set() {
    local pairs=(
        "global.image.repository=$IMAGE_REPO"
        "global.image.tag=$IMAGE_TAG"
        "global.image.pullPolicy=$IMAGE_PULL_POLICY"
        "global.appHost=$APP_HOST"
        "global.ingressClassName=$INGRESS_CLASS"
        "global.tlsIssuer=$TLS_ISSUER"
        "global.awsRegion=$AWS_REGION"
        "global.fromAddress=$FROM_ADDRESS"
        # The mail key is a Secret value rather than a global, so it goes
        # through secrets.values, which the chart reads before it reads the
        # cluster and before it generates anything. The chart never generates
        # this one: an invented API key would replace a clean unconfigured state
        # with 401s.
        "secrets.values.SENDGRID_API_KEY=$SENDGRID_API_KEY"
        "global.turnstileSecretKey=$TURNSTILE_SECRET_KEY"
        "global.db.secretName=$DB_SECRET_NAME"
        "global.db.secretKey=$DB_SECRET_KEY"
        "global.queue.url=$SQS_QUEUE_URL"
        "global.queue.dlqUrl=$SQS_DLQ_URL"
        "global.queue.endpoint=$AWS_ENDPOINT_URL"
        "global.queue.credentialsSecretName=$AWS_CREDENTIALS_SECRET"
        "postgresql.instances=$PG_INSTANCES"
        "postgresql.storage.size=$PG_STORAGE_SIZE"
        "secrets.runnerSecretPrefix=$RUNNER_SECRET_PREFIX"
    )
    local pair
    for pair in "${pairs[@]}"; do
        [ -n "${pair#*=}" ] && SET_ARGS+=(--set "$pair")
    done

    # The second hostname, when there is one. Appending to the ingress host list
    # by index rather than replacing it keeps APP_HOST as the first rule, and
    # global.appAliasHost is what values.yaml appends to
    # ADDITIONAL_TRUSTED_ORIGINS. Both are needed: serving a host the CSRF guard
    # does not trust gives a UI that loads and reads while every write returns
    # 403, which is the quietest failure in this whole install.
    if [ -n "$APP_ALIAS_HOST" ]; then
        SET_ARGS+=(--set "global.appAliasHost=$APP_ALIAS_HOST")
        SET_ARGS+=(--set "app.ingress.hosts[1]=$APP_ALIAS_HOST")
    fi
}

# A working-tree chart when CHART_DIR is set, the published one otherwise. The
# --version flag is meaningless for a directory and helm rejects it there.
# The chain configuration, as a Secret the app and the db-migration
# initContainer both read.
#
# It is created unconditionally, with an empty value when nothing is set, and
# that is the one place in this script where an empty value is correct rather
# than merely tolerated. values.yaml references this key from the shared_env
# anchor, and a `type: secret` reference to a key that does not exist leaves the
# pod in CreateContainerConfigError, which --atomic then rolls back. An empty
# value is safe to read: parseRpcConfig in lib/rpc/rpc-config.ts evaluates
# `envValue || "{}"`, so empty falls through to the public RPC defaults.
#
# The initContainer is the reason this is not a plain values entry. Chain
# endpoints are written into the chains table by seed-chains.ts when the
# migrator runs, so the value has to be present at seed time. An anchor is
# expanded when its own file is parsed, so no later -f can reach shared_env.
create_integrations_secret() {
    [ "$DRY_RUN" = false ] || return 0
    kube_ns create secret generic keeperhub-integrations \
        --from-literal=CHAIN_RPC_CONFIG="${CHAIN_RPC_CONFIG:-}" \
        --dry-run=client -o yaml | kube apply -f -
    if [ -n "${CHAIN_RPC_CONFIG:-}" ]; then
        ok "chain configuration (keeperhub-integrations)"
    else
        ok "chain configuration empty, public RPC defaults will be seeded"
    fi
}

# The credentials the executor hands to runner Job pods.
#
# The executor builds each reference as "<prefix>-<slug>" with the key equal to
# the name (keeperhub-executor/k8s-job.ts), so both have to match exactly. Only
# slugs whose source variable is set are created; check_runner_secrets still
# reports the rest.
create_runner_secrets() {
    [ "$DRY_RUN" = false ] || return 0

    local entry slug var value name created=0
    for entry in "${RUNNER_SECRET_SOURCES[@]}"; do
        slug="${entry%%|*}"
        var="${entry#*|}"
        value="${!var:-}"
        [ -n "$value" ] || continue
        name="${RUNNER_SECRET_PREFIX}-${slug}"
        kube_ns create secret generic "$name" \
            --from-literal="$name=$value" \
            --dry-run=client -o yaml | kube apply -f -
        created=$((created + 1))
    done

    [ "$created" -gt 0 ] && ok "$created runner credentials created from the environment"
    return 0
}

# Third-party configuration, rendered as a values fragment rather than passed
# with --set.
#
# Only variables that are actually set are written. An unset variable must stay
# absent rather than become an empty string, because several of these are read
# with `??`, which falls back on undefined but not on "". Writing them all
# unconditionally would replace working defaults with nothing.
INTEGRATION_VALUES_FILE=""
render_integration_values() {
    local var value present=() secrets=()
    for var in "${APP_INTEGRATION_VARS[@]}"; do
        value="${!var:-}"
        [ -n "$value" ] && present+=("$var")
    done
    for var in "${CHART_SECRET_VARS[@]}"; do
        value="${!var:-}"
        [ -n "$value" ] && secrets+=("$var")
    done
    [ "${#present[@]}" -gt 0 ] || [ "${#secrets[@]}" -gt 0 ] || return 0

    # mktemp rather than a path in the repository, and removed on exit, because
    # this file holds the operator's credentials in plain text.
    INTEGRATION_VALUES_FILE="$(mktemp -t keeperhub-integrations-XXXXXX.yaml)"
    chmod 600 "$INTEGRATION_VALUES_FILE"
    {
        echo "# Generated by install.sh. Do not edit; it is recreated every run."
        if [ "${#secrets[@]}" -gt 0 ]; then
            echo "secrets:"
            echo "  values:"
            for var in "${secrets[@]}"; do
                value="${!var}"
                printf "    %s: '%s'\n" "$var" "${value//\'/\'\'}"
            done
        fi
        if [ "${#present[@]}" -gt 0 ]; then
            echo "app:"
            echo "  env:"
            for var in "${present[@]}"; do
                value="${!var}"
                # Single-quoted YAML with '' escaping, and type kv rather than
                # template, so a value containing {{ is never run through tpl.
                printf "    %s:\n      type: kv\n      value: '%s'\n" \
                    "$var" "${value//\'/\'\'}"
            done
        fi
    } >"$INTEGRATION_VALUES_FILE"

    VALUES_ARGS+=(-f "$INTEGRATION_VALUES_FILE")
    [ "${#secrets[@]}" -gt 0 ] && ok "${#secrets[@]} stored secrets: ${secrets[*]}"
    [ "${#present[@]}" -gt 0 ] && ok "${#present[@]} third-party settings: ${present[*]}"
    return 0
}

cleanup_integration_values() {
    [ -n "$INTEGRATION_VALUES_FILE" ] && rm -f "$INTEGRATION_VALUES_FILE"
    return 0
}
trap cleanup_integration_values EXIT

# Applied before the chart, so the Service the app and executor are configured
# to call already resolves when their first pod starts. Neither blocks on it, so
# the order is a courtesy rather than a requirement.
#
# Not part of the Helm release on purpose: --atomic would then delete the
# sandbox on any unrelated rollback, and the pod that runs untrusted code is the
# last one that should come and go with a failed upgrade of something else.
apply_sandbox() {
    [ "$SANDBOX_ENABLED" = true ] || return 0
    section "Applying the sandbox"

    # The chart defaults this when it is empty, but a raw manifest has no such
    # default and an empty imagePullPolicy is not valid.
    local pull_policy="${IMAGE_PULL_POLICY:-IfNotPresent}"

    if [ -z "$IMAGE_REPO" ] || [ -z "$IMAGE_TAG" ]; then
        echo "SANDBOX_ENABLED=true needs IMAGE_REPO and IMAGE_TAG." >&2
        echo "The sandbox is a plain manifest, so it cannot read them from the chart." >&2
        exit 1
    fi

    if [ "$DRY_RUN" = true ]; then
        NAMESPACE="$NAMESPACE" IMAGE_REPO="$IMAGE_REPO" IMAGE_TAG="$IMAGE_TAG" \
            IMAGE_PULL_POLICY="$pull_policy" \
            envsubst '${NAMESPACE} ${IMAGE_REPO} ${IMAGE_TAG} ${IMAGE_PULL_POLICY}' \
            <"$SCRIPT_DIR/sandbox.yaml"
        return 0
    fi

    NAMESPACE="$NAMESPACE" IMAGE_REPO="$IMAGE_REPO" IMAGE_TAG="$IMAGE_TAG" \
        IMAGE_PULL_POLICY="$pull_policy" \
        envsubst '${NAMESPACE} ${IMAGE_REPO} ${IMAGE_TAG} ${IMAGE_PULL_POLICY}' \
        <"$SCRIPT_DIR/sandbox.yaml" | kube apply -f -
    ok "keeperhub-sandbox on ${IMAGE_REPO}:sandbox-${IMAGE_TAG}"
}

# The egress policy, applied after the chart so a failed install does not leave
# a namespace that denies its own traffic.
#
# Warns rather than fails when the CNI does not enforce policy, because the
# objects apply cleanly either way and the difference is invisible afterwards.
apply_egress_policy() {
    [ "$EGRESS_POLICY" = true ] || return 0
    section "Applying the egress policy"

    if [ "$DRY_RUN" = true ]; then
        NAMESPACE="$NAMESPACE" APISERVER_CIDR="$APISERVER_CIDR" \
            envsubst '${NAMESPACE} ${APISERVER_CIDR}' <"$SCRIPT_DIR/networkpolicy.yaml"
        return 0
    fi

    NAMESPACE="$NAMESPACE" APISERVER_CIDR="$APISERVER_CIDR" \
        envsubst '${NAMESPACE} ${APISERVER_CIDR}' \
        <"$SCRIPT_DIR/networkpolicy.yaml" | kube apply -f -

    # A NetworkPolicy object is accepted by every cluster. Only a CNI that
    # implements it does anything with it, and the two look identical from
    # kubectl, so say which one this is.
    if kube get daemonset -n kube-system 2>/dev/null | grep -qE 'calico|cilium|weave|antrea|kube-router'; then
        ok "egress policy applied and the CNI enforces it"
    else
        warn "egress policy applied, but no enforcing CNI was found in kube-system."
        warn "The objects exist and nothing is being restricted. Install a CNI"
        warn "that implements NetworkPolicy, or treat this as documentation only."
    fi
}

chart_ref() {
    if [ -n "$CHART_DIR" ]; then printf '%s' "$CHART_DIR"; else printf '%s' "$CHART_NAME"; fi
}

install_chart() {
    local version_args=()
    if [ -n "$CHART_DIR" ]; then
        section "Installing keeperhub-stack from $CHART_DIR"
    else
        section "Installing keeperhub-stack $CHART_VERSION"
        helm repo add "$CHART_REPO_NAME" "$CHART_REPO_URL" >/dev/null
        helm repo update "$CHART_REPO_NAME" >/dev/null
        version_args=(--version "$CHART_VERSION")
    fi

    if [ "$DRY_RUN" = true ]; then
        helm template "$RELEASE" "$(chart_ref)" \
            "${version_args[@]+"${version_args[@]}"}" \
            --namespace "$NAMESPACE" \
            "${VALUES_ARGS[@]}" "${SET_ARGS[@]+"${SET_ARGS[@]}"}"
        return 0
    fi

    # --atomic rolls the whole release back if any component fails readiness.
    # The generated Secrets survive that, by helm.sh/resource-policy: keep.
    helm upgrade --install "$RELEASE" "$(chart_ref)" \
        --kube-context "$KUBE_CONTEXT" \
        "${version_args[@]+"${version_args[@]}"}" \
        --namespace "$NAMESPACE" --create-namespace \
        "${VALUES_ARGS[@]}" "${SET_ARGS[@]+"${SET_ARGS[@]}"}" \
        --atomic --wait --timeout "$HELM_TIMEOUT"
    ok "release $RELEASE installed"
}

main() {
    preflight
    ensure_namespace
    create_aws_credentials_secret
    create_integrations_secret
    create_runner_secrets
    apply_sandbox
    compose_values
    render_integration_values
    compose_set
    install_chart

    [ "$DRY_RUN" = true ] && exit 0

    apply_egress_policy
    check_runner_secrets

    echo ""
    echo "== Installed"
    echo "   release   $RELEASE in namespace $NAMESPACE on $KUBE_CONTEXT"
    echo "   app       https://$APP_HOST"
    echo "   database  $DB_MODE"
    echo "   queue     $QUEUE_MODE"
    echo ""
    echo "   Secrets were generated by the chart and are kept across upgrades."
    echo "   Changing one does not restart the pods that read it:"
    echo ""
    echo "     kubectl --context $KUBE_CONTEXT -n $NAMESPACE rollout restart deployment \\"
    echo "       -l app.kubernetes.io/instance=$RELEASE"
    echo ""
}

main
