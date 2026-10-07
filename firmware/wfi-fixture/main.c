/*
 * wfi-fixture: input for src/ui/controls.test.ts, not a lesson.
 *
 * It sleeps forever: WFI with no interrupt enabled. The simulator skips
 * sleeping time in 1 ms steps, so this runs far faster than real time, and
 * the UI's "max" speed shows plainly against "real time" on any machine.
 */
int main(void) {
  for (;;) {
    __asm volatile("wfi");
  }
}
