/*
 * elf-fixture: input for src/engine/elf.test.ts, not a lesson.
 *
 * blink has no initialised variables, so its .data section is empty. This
 * program has one, so the test can check that .data's starting value is stored
 * in flash, where the startup code copies it from.
 */
#include <stdint.h>

/* Runs from RAM; its starting value is kept in flash. `volatile` stops the
   compiler from keeping it in a register instead. */
volatile uint32_t answer = 0xC0FFEE42U;

int main(void) {
  for (;;) {
    answer++;
  }
}
