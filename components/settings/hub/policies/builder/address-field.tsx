"use client";

import { isValidAddress } from "@/lib/policy";
import { addressBookOptions, type PolicyOption } from "@/lib/policy/ui";
import { usePolicyCatalog } from "../policy-context";
import { FieldLabel } from "./field-label";
import { SearchableSelect } from "./searchable-select";

/**
 * An address, picked from the address book or typed.
 *
 * One control does both. The book is offered because those are the addresses
 * the organization has already decided matter, and anything else is accepted
 * as it is typed: a rule about an address is often written before anyone
 * bookmarks it, and a separate mode to switch into is a step that is easy to
 * miss and easy to forget exists.
 */
export function AddressField({
  id,
  label,
  hint,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (next: string) => void;
}): React.ReactElement {
  const { catalog } = usePolicyCatalog();

  const typedAddress = (query: string): PolicyOption | null => {
    const trimmed = query.trim();
    if (!isValidAddress(trimmed)) {
      return null;
    }
    return {
      value: trimmed,
      label: trimmed,
      hint: "Use this address, which is not in the address book",
    };
  };

  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel hint={hint} htmlFor={id}>
        {label}
      </FieldLabel>
      <SearchableSelect
        customOption={typedAddress}
        id={id}
        onChange={onChange}
        options={addressBookOptions(catalog)}
        placeholder="Choose from the address book, or type an address"
        searchPlaceholder="Search the book, or paste an address"
        value={value}
      />
    </div>
  );
}
