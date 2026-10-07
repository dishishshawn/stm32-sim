// The Part panel (T43): the part selected on the canvas, with one control per
// prop from its PropSpec: a select for options, a number input with min and
// max, a checkbox for a boolean. A change is checked with propError(), then
// applied through ui.change(), so the simulation restarts and Save writes it.
// A prop set back to its default is left out of the file, as a hand-written one would.
import { catalog } from "../engine/engine.ts";
import { propError } from "../parts/part.ts";
import type { PropSpec, PropValue } from "../parts/part.ts";
import type { Panel } from "./ui.ts";

const CSS = `
.part-props { border: 0; margin: 0; padding: 0; display: grid; gap: 0.4rem; justify-items: start; }
.part-props legend { padding: 0 0 0.4rem; font-weight: 600; }
.part-props label { display: flex; gap: 0.5rem; align-items: center; }
.part-props input[type="number"] { width: 8ch; }
#part-error { color: var(--high); margin: 0.4rem 0 0; }
`;

export const propsPanel: Panel = (ui) => {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  const body = ui.panel("Part");
  const error = document.createElement("p");
  error.id = "part-error";
  error.setAttribute("role", "alert");

  /** One control for prop `name` of part `id`. */
  const control = (
    id: string,
    name: string,
    spec: PropSpec,
    now: PropValue,
  ) => {
    const label = document.createElement("label");
    let input: HTMLInputElement | HTMLSelectElement;
    if (spec.type === "string" && spec.options) {
      input = document.createElement("select");
      input.append(...spec.options.map((o) => new Option(o)));
    } else {
      input = document.createElement("input");
      if (spec.type === "boolean") input.type = "checkbox";
      if (spec.type === "number") {
        input.type = "number";
        input.step = "any";
        if (spec.min !== undefined) input.min = String(spec.min);
        if (spec.max !== undefined) input.max = String(spec.max);
      }
    }
    if (input instanceof HTMLInputElement && spec.type === "boolean")
      input.checked = now === true;
    else input.value = String(now);
    input.setAttribute("aria-describedby", error.id);
    input.addEventListener("change", () => {
      const value =
        input instanceof HTMLSelectElement
          ? input.value
          : spec.type === "boolean"
            ? input.checked
            : spec.type === "number"
              ? input.valueAsNumber // NaN when empty or not a number
              : input.value;
      const why = propError(spec, value);
      input.setAttribute("aria-invalid", String(why !== undefined));
      error.textContent = why ? `${name}: ${why}` : "";
      if (why) return;
      void ui.change(() => {
        const i = ui.circuit.parts.findIndex((p) => p.id === id);
        const props = { ...ui.circuit.parts[i].props, [name]: value };
        if (value === spec.default) delete props[name];
        // A new object, so change() can put the old one back if the restart fails.
        ui.circuit.parts[i] = { ...ui.circuit.parts[i], props };
        return `set ${id}.${name} to ${value}`;
      });
    });
    label.append(`${name} `, input);
    return label;
  };

  const show = (id: string | undefined) => {
    const part = ui.circuit.parts.find((p) => p.id === id);
    error.textContent = "";
    if (!part) {
      body.textContent = "Click a part to see its props.";
      return;
    }
    const specs = catalog.parts.find((t) => t.type === part.type)!.props;
    const set = document.createElement("fieldset");
    set.className = "part-props";
    const legend = document.createElement("legend");
    legend.textContent = `${part.id} (${part.type})`;
    set.append(legend);
    for (const [name, spec] of Object.entries(specs))
      set.append(
        control(part.id, name, spec, part.props[name] ?? spec.default),
      );
    if (!Object.keys(specs).length) set.append("No props.");
    body.replaceChildren(set, error);
  };
  ui.onSelect(show);
  show(undefined);
};
