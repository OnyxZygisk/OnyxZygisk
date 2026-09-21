import { Cli } from "../cli";
import { History } from "../history";
import { Keybind } from "../keybind";

/*
 * Single instances for the whole WebUI. These are plain classes rather than
 * React context because they own lifetimes that outlive any component: the
 * back stack and the shell session.
 */
export const cli = new Cli();
export const history = new History();
export const keybind = new Keybind();
