// T33: when `sim ui` sees the ELF rebuilt (its /events), loads the new
// firmware into the engine, keeping the circuit and resetting the MCU, and
// says so briefly in the header toolbar.
import type { Ui } from "./ui.ts";

export function watch(ui: Ui): void {
  const status = document.createElement("span");
  status.id = "reload";
  status.setAttribute("role", "status");
  ui.toolbar.append(status);
  let halted = false;
  ui.onSnapshot((s) => (halted = s.halt !== null));
  let timer: ReturnType<typeof setTimeout> | undefined;
  new EventSource("/events").onmessage = async () => {
    // ponytail: main.ts's frame loop stops on a halt and a panel can't restart
    // it, so a halted page reloads whole (rereading the circuit file).
    if (halted) return location.reload();
    clearTimeout(timer);
    try {
      const r = await fetch("/elf");
      if (!r.ok) throw new Error(await r.text());
      // ponytail: parts restart from the circuit's props, so a moved slider
      // shows its old value until moved again; re-send the controls' values
      // if that confuses anyone.
      ui.engine.load(new Uint8Array(await r.arrayBuffer()), ui.circuit);
      status.textContent = `firmware reloaded at ${new Date().toTimeString().slice(0, 8)}`;
      timer = setTimeout(() => (status.textContent = ""), 5000);
    } catch (e) {
      // A broken ELF: the old firmware keeps running.
      status.textContent = `firmware reload failed: ${(e as Error).message}`;
    }
  };
}
