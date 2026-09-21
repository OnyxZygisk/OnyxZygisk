import * as RadixSlider from "@radix-ui/react-slider";
import { cx } from "../../utils/cx";

export interface SliderProps {
	value: number;
	onChange: (value: number) => void;
	min?: number;
	max?: number;
	step?: number;
	"aria-label": string;
	/**
	 * The slider always fills its container, so size the wrapper instead of
	 * passing a width here. A width in this class list competes with the
	 * component's own w-full, and CSS resolves that by stylesheet order rather
	 * than by the order the classes appear — passing one collapsed the control
	 * to the thumb's 16 px and left no visible track.
	 */
	className?: string;
}

export function Slider({
	value,
	onChange,
	min = 0,
	max = 100,
	step = 1,
	className,
	...aria
}: SliderProps) {
	return (
		<RadixSlider.Root
			value={[value]}
			onValueChange={([next]) => onChange(next ?? min)}
			min={min}
			max={max}
			step={step}
			className={cx(
				"relative flex h-5 w-full touch-none select-none items-center",
				className,
			)}
		>
			{/*
			 * The track uses divider rather than a container step: a container step
			 * is invisible against the surface row a slider normally sits on.
			 */}
			<RadixSlider.Track className="relative h-1 grow rounded-full bg-onx-divider">
				<RadixSlider.Range className="absolute h-full rounded-full bg-onx-accent" />
			</RadixSlider.Track>
			{/* role="slider" lives on the thumb, so the accessible name must too. */}
			<RadixSlider.Thumb
				{...aria}
				className="block size-4 rounded-full border border-onx-divider bg-onx-surface"
			/>
		</RadixSlider.Root>
	);
}
