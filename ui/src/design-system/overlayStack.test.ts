import { describe, expect, it, vi } from "vitest";
import { createOverlayStack, type OverlayLayer } from "./overlayStack";

function layer(overrides: Partial<OverlayLayer> = {}): OverlayLayer {
  return { onEscape: vi.fn(), trapsFocus: false, parent: null, ...overrides };
}

function escape(key = "Escape", isComposing = false) {
  return { key, isComposing, preventDefault: vi.fn(), stopPropagation: vi.fn() };
}

describe("overlay stack", () => {
  it("gives Escape to the topmost layer only", () => {
    // The reported bug: Generate Map over Host Game, and one press closed both.
    const stack = createOverlayStack();
    const host = layer({ trapsFocus: true });
    const generate = layer({ trapsFocus: true });
    stack.push(host);
    stack.push(generate);

    const event = escape();
    expect(stack.handleKey(event)).toBe(true);
    expect(generate.onEscape).toHaveBeenCalledTimes(1);
    expect(host.onEscape).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it("reaches the layer underneath once the top one is gone", () => {
    const stack = createOverlayStack();
    const dialog = layer({ trapsFocus: true });
    const list = layer();
    stack.push(dialog);
    const closeList = stack.push(list);

    stack.handleKey(escape());
    expect(list.onEscape).toHaveBeenCalledTimes(1);
    closeList();

    stack.handleKey(escape());
    expect(dialog.onEscape).toHaveBeenCalledTimes(1);
    expect(list.onEscape).toHaveBeenCalledTimes(1);
  });

  it("swallows Escape for a layer that does nothing with it", () => {
    // A dialog that may not be dismissed: the press stops there rather than
    // closing whatever is underneath.
    const stack = createOverlayStack();
    const below = layer();
    stack.push(below);
    stack.push(layer({ onEscape: () => {} }));

    expect(stack.handleKey(escape())).toBe(true);
    expect(below.onEscape).not.toHaveBeenCalled();
  });

  it("leaves other keys, composition and an empty stack alone", () => {
    const stack = createOverlayStack();
    const empty = escape();
    expect(stack.handleKey(empty)).toBe(false);
    expect(empty.stopPropagation).not.toHaveBeenCalled();

    const only = layer();
    stack.push(only);
    expect(stack.handleKey(escape("Enter"))).toBe(false);
    expect(stack.handleKey(escape("Escape", true))).toBe(false);
    expect(only.onEscape).not.toHaveBeenCalled();
  });

  it("orders a parent below a child that registered first", () => {
    // Effects run child first, so a dialog that mounts with a list already
    // open inside it registers after the list.
    const stack = createOverlayStack();
    const dialog = layer({ trapsFocus: true });
    const list = layer({ parent: dialog });
    stack.push(list);
    stack.push(dialog);
    expect(stack.top()).toBe(list);
  });

  it("puts an unrelated layer on top", () => {
    const stack = createOverlayStack();
    const first = layer();
    const second = layer();
    stack.push(first);
    stack.push(second);
    expect(stack.top()).toBe(second);
    expect(stack.size()).toBe(2);
  });

  it("keeps the focus trap with the topmost dialog, not a list above it", () => {
    const stack = createOverlayStack();
    const outer = layer({ trapsFocus: true });
    const inner = layer({ trapsFocus: true });
    stack.push(outer);
    const closeInner = stack.push(inner);
    stack.push(layer());

    expect(stack.topFocusTrap()).toBe(inner);
    closeInner();
    expect(stack.topFocusTrap()).toBe(outer);
  });

  it("unregisters only once", () => {
    const stack = createOverlayStack();
    const first = layer();
    const remove = stack.push(first);
    stack.push(layer());
    remove();
    remove();
    expect(stack.size()).toBe(1);
  });
});
