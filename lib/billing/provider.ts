export type CreateCheckoutParams = {
  customerId: string;
  priceId: string;
  organizationId: string;
  successUrl: string;
  cancelUrl: string;
  // When set, the subscription starts with a free trial of this many days.
  trialPeriodDays?: number;
};

export type CreateCustomerParams = {
  email: string;
  organizationId: string;
  userId: string;
};

export type BillingWebhookEvent = {
  type:
    | "checkout.completed"
    | "subscription.updated"
    | "subscription.deleted"
    | "invoice.created"
    | "invoice.paid"
    | "invoice.payment_failed"
    | "invoice.overdue"
    | "invoice.payment_action_required";
  providerEventId: string;
  data: {
    providerSubscriptionId?: string;
    providerCustomerId?: string;
    invoiceId?: string;
    organizationId?: string;
    priceId?: string;
    status?: string;
    cancelAtPeriodEnd?: boolean;
    periodStart?: Date;
    periodEnd?: Date | null;
    invoiceUrl?: string;
    // Stripe's billing_reason, used to tell a cycle renewal invoice apart from
    // a one-off or proration invoice.
    billingReason?: string;
    // Metadata from Stripe used to resolve custom enterprise plans whose price
    // IDs aren't in the env-var map. Subscription metadata takes precedence.
    subscriptionMetadata?: Record<string, string>;
    priceMetadata?: Record<string, string>;
  };
};

export type InvoiceItem = {
  id: string;
  date: Date;
  amount: number;
  currency: string;
  status: "paid" | "open" | "void" | "draft" | "uncollectible";
  description: string;
  periodStart: Date;
  periodEnd: Date;
  invoiceUrl: string | null;
  pdfUrl: string | null;
};

export type ListInvoicesParams = {
  customerId: string;
  limit: number;
  startingAfter?: string;
};

export type ListInvoicesResult = {
  invoices: InvoiceItem[];
  hasMore: boolean;
};

export type SubscriptionDetails = {
  priceId: string | undefined;
  status: string;
  cancelAtPeriodEnd: boolean;
  periodStart: Date;
  periodEnd: Date | null;
  subscriptionMetadata?: Record<string, string>;
  priceMetadata?: Record<string, string>;
};

export type CreateInvoiceItemParams = {
  customerId: string;
  amount: number;
  currency: string;
  description: string;
  metadata?: Record<string, string>;
  // Attach to this specific draft invoice. Without it the item is left pending
  // and the provider only sweeps it into whichever invoice is created next.
  invoiceId?: string;
};

export type CreateInvoiceItemResult = {
  invoiceItemId: string;
};

export type ProrationPreview = {
  amountDue: number;
  subtotal: number;
  appliedBalance: number;
  currency: string;
  periodEnd: Date | null;
  lineItems: {
    description: string;
    amount: number;
    proration: boolean;
  }[];
};

export type BillingDetails = {
  paymentMethod: {
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
  } | null;
  billingEmail: string | null;
};

export interface BillingProvider {
  readonly name: string;

  createCustomer(params: CreateCustomerParams): Promise<{ customerId: string }>;

  createCheckoutSession(params: CreateCheckoutParams): Promise<{ url: string }>;

  createPortalSession(
    customerId: string,
    returnUrl: string
  ): Promise<{ url: string }>;

  getBillingDetails(customerId: string): Promise<BillingDetails>;

  verifyWebhook(body: string, signature: string): Promise<BillingWebhookEvent>;

  getSubscriptionDetails(subscriptionId: string): Promise<SubscriptionDetails>;

  listInvoices(params: ListInvoicesParams): Promise<ListInvoicesResult>;

  updateSubscription(
    subscriptionId: string,
    newPriceId: string,
    options?: { endTrial?: boolean }
  ): Promise<{ subscriptionId: string }>;

  cancelSubscription(
    subscriptionId: string
  ): Promise<{ cancelAtPeriodEnd: boolean; periodEnd: Date | null }>;

  previewProration(
    subscriptionId: string,
    newPriceId: string,
    options?: { endTrial?: boolean }
  ): Promise<ProrationPreview>;

  createInvoiceItem(
    params: CreateInvoiceItemParams
  ): Promise<CreateInvoiceItemResult>;

  getInvoiceStatus(
    invoiceId: string
  ): Promise<{ status: string; paid: boolean }>;

  getInvoiceForItem(
    invoiceItemId: string
  ): Promise<{ invoiceId: string; status: string; paid: boolean } | undefined>;
}
