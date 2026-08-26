"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addressBookOptions } from "@/lib/policy/ui";
import { usePolicyCatalog } from "../policy-context";
import { FieldLabel } from "./field-label";
import { SearchableSelect } from "./searchable-select";

/**
 * An address, chosen from the address book or typed.
 *
 * The book is offered first because those are the addresses the organization
 * has already decided matter. Typing stays available: a rule about an address
 * is often written before anyone bookmarks it, and requiring a bookmark first
 * would make the rule wait on unrelated bookkeeping.
 */
export function AddressField({
  id,
  label,
  hint,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  placeholder?: string;
  onChange: (next: string) => void;
}): React.ReactElement {
  const { catalog } = usePolicyCatalog();
  const options = addressBookOptions(catalog);
  const known = options.some((option) => option.value === value);
  const [typing, setTyping] = useState(value.length > 0 && !known);

  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel hint={hint} htmlFor={id}>
        {label}
      </FieldLabel>

      {typing || options.length === 0 ? (
        <Input
          className="font-mono text-xs"
          id={id}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? "0x..."}
          spellCheck={false}
          value={value}
        />
      ) : (
        <SearchableSelect
          id={id}
          onChange={onChange}
          options={options}
          placeholder="Choose from the address book"
          searchPlaceholder="Search the address book"
          value={value}
        />
      )}

      {options.length > 0 && (
        <Button
          className="self-start px-0"
          onClick={() => setTyping((current) => !current)}
          size="sm"
          variant="link"
        >
          {typing ? "Choose from the address book" : "Enter an address instead"}
        </Button>
      )}
    </div>
  );
}
