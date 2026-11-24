type Props = {
  popular: boolean
  onSwitch: (popular: boolean) => void
}

/** Feed-mode toggle (Random = whole catalogue, Popular = currently
 * popular), fixed at the top centre in both the loading and feed views. */
export default function ModeToggle({ popular, onSwitch }: Props) {
  return (
    <div
      className="fixed top-3 left-1/2 -translate-x-1/2 z-30 flex rounded-full bg-white/10 backdrop-blur border border-white/20 overflow-hidden"
      role="group"
      aria-label="Feed mode"
    >
      <button
        type="button"
        onClick={() => onSwitch(false)}
        aria-pressed={!popular}
        className={`px-7 py-4 text-base font-medium ${popular ? "text-white" : "bg-white text-black"}`}
      >
        Random
      </button>
      <button
        type="button"
        onClick={() => onSwitch(true)}
        aria-pressed={popular}
        className={`px-7 py-4 text-base font-medium ${popular ? "bg-white text-black" : "text-white"}`}
      >
        Popular
      </button>
    </div>
  )
}
