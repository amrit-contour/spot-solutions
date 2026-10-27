import { IconSearch, TextInput } from "@spot/ui";

/** Search box: icon inside the left edge, 48px tall, native clear button. Goes at the top of a page body, not in the header. */
export function SearchField({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label?: string }) {
  return (
    <div className="relative min-w-0">
      <IconSearch aria-hidden className="icon pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-on-surface-variant" />
      <TextInput type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={label ?? placeholder} className="pl-12" />
    </div>
  );
}
