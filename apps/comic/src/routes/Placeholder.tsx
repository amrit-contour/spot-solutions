import { Empty, PageHeader, type Icon } from "@spot/ui";

/** A page that's still to be built: the real header, plus an Empty state saying what's coming. */
export function Placeholder({ icon, title, subtitle, empty, text }: { icon: Icon; title: string; subtitle: string; empty: string; text: string }) {
  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />
      <div className="px-4 pt-6 sm:px-8">
        <Empty icon={icon} title={empty}>
          {text}
        </Empty>
      </div>
    </div>
  );
}
