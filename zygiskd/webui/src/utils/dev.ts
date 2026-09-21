import { getBridge } from "../bridge";

export function isDev(): boolean {
	return import.meta.env.DEV && !getBridge().isWebui();
}
