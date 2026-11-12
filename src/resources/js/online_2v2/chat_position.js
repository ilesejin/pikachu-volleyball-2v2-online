// Percentage anchors plus a width-relative transform keep the bubble horizontally inside its slot.
// Older replay packets omit area and retain their original side-based placement.
export function applyChatPosition(bubble, position) {
  const style = bubble.style;
  style.top = position.top + '%';
  style.overflowWrap =
    style.fontSize =
    style.padding =
    style.maxHeight =
    style.overflow =
      '';
  style.left =
    style.right =
    style.transform =
    style.width =
    style.maxWidth =
      '';
  if (
    Number.isInteger(position.area) &&
    position.area >= 0 &&
    position.area < 4
  ) {
    const fraction = Math.max(0, Math.min(1, (position.offset - 55) / 25));
    style.left = position.area * 25 + 1.25 + 22.5 * fraction + '%';
    style.transform =
      'translate(' + -100 * fraction + '%, ' + -position.top + '%)';
    style.width = 'max-content';
    style.maxWidth = '22.5%';
    style.overflowWrap = 'anywhere';
    style.fontSize =
      'min(calc(1.5 * var(--font-size)), calc(var(--canvas-width) / 40))';
    style.padding = 'min(10px, calc(var(--canvas-width) / 80))';
    style.maxHeight = '90%';
    style.overflow = 'hidden';
  } else if (position.side === 'left') style.right = position.offset + '%';
  else if (position.side === 'right') style.left = position.offset + '%';
  else {
    style.left = '50%';
    style.transform = 'translateX(-50%)';
  }
}
