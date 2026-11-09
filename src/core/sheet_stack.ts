/**
 * The open sheets, bottom to top.  A sheet opened while another is open (a
 * confirm from Settings, say) goes on top of it; Escape and a click outside
 * close only the top one, and closing it shows the one below again.  Kept
 * apart from the DOM (src/ui/overlays.ts shows them) so it can be tested.
 */
export interface StackedSheet {
  /** Closes the sheet: removes it from the stack, then from the page. */
  close(): void;
}

export class SheetStack<T extends StackedSheet = StackedSheet> {
  private readonly sheets: T[] = [];
  /** Above zero while a sheet's close runs (its onClose included). */
  private closing = 0;

  get size(): number {
    return this.sheets.length;
  }

  top(): T | undefined {
    return this.sheets[this.sheets.length - 1];
  }

  /** The sheet under the top one, which a new sheet covers. */
  below(): T | undefined {
    return this.sheets[this.sheets.length - 2];
  }

  push(sheet: T): void {
    this.sheets.push(sheet);
  }

  /** Takes a sheet off, wherever it is; false when it was not open. */
  remove(sheet: T): boolean {
    const i = this.sheets.indexOf(sheet);
    if (i < 0) return false;
    this.sheets.splice(i, 1);
    return true;
  }

  /** Runs a sheet's closing work; `closeTop` does nothing meanwhile. */
  closingWhile(work: () => void): void {
    this.closing++;
    try {
      work();
    } finally {
      this.closing--;
    }
  }

  /**
   * Closes the top sheet: Escape, a click outside, or `closeSheet()`.  Not
   * while a sheet is closing: a dialog's onClose that answers it (and so
   * asks to close "the sheet" again) must not close the one below.
   */
  closeTop(): void {
    if (this.closing > 0) return;
    this.top()?.close();
  }
}
