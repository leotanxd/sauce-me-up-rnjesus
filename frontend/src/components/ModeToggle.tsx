type Props = {
  popular: boolean
  onSwitch: (popular: boolean) => void
}

/** Feed-mode toggle (Random = whole catalogue, Popular = currently
 * popular), fixed at the top centre in both the loading and feed views. */
export default function ModeToggle({ popular, onSwitch }: Props) {
  // The focus ring is inset because the group container clips
  // overflow — an outer ring would be cut off. The selected button
  // wears the ember fill, so its ring is white (the same treatment
  // as the filled accent pill): an ember ring on the ember fill
  // would vanish.
  const ringBase =
    "transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset"
  const ring = `${ringBase} focus-visible:ring-ember`
  const ringSelected = `${ringBase} focus-visible:ring-white`
  return (
    <div
      className="fixed top-[max(0.75rem,env(safe-area-inset-top))] left-1/2 -translate-x-1/2 z-30 flex rounded-full bg-white/10 backdrop-blur border border-white/20 overflow-hidden"
      role="group"
      aria-label="Feed mode"
    >
      <button
        type="button"
        onClick={() => onSwitch(false)}
        aria-pressed={!popular}
        className={`px-7 py-4 text-base font-medium ${popular ? `${ring} text-white hover:bg-white/10` : `${ringSelected} bg-ember text-black`}`}
      >
        Random
      </button>
      <button
        type="button"
        onClick={() => onSwitch(true)}
        aria-pressed={popular}
        className={`px-7 py-4 text-base font-medium ${popular ? `${ringSelected} bg-ember text-black` : `${ring} text-white hover:bg-white/10`}`}
      >
        Popular
      </button>
    </div>
  )
}
