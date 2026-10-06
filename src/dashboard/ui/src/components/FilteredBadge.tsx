/**
 * 'Filtered: Dining' — marks a card that honors the global category filter
 * (the URL `cat` key, which is also the spending drill's level-2 key), so a
 * drilled-in Overview never passes off a category slice as the whole picture.
 */
export function FilteredBadge({ category }: { category: string | null | undefined }) {
  if (!category) return null;
  return (
    <span
      title={`This card is filtered to ${category}`}
      className="inline-flex items-center max-w-[160px] text-[10px] px-1.5 py-0.5 rounded border border-green/40 bg-green/10 text-green whitespace-nowrap"
    >
      <span className="truncate">Filtered: {category}</span>
    </span>
  );
}
