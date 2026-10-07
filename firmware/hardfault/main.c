/*
 * hardfault: run an undefined instruction, so the CPU takes a HardFault.
 *
 * ST's startup code points HardFault_Handler at Default_Handler, an infinite
 * loop, so the firmware ends up stuck there. `sim run` exits 1 and names the
 * line below as the faulting instruction. The CLI tests use it.
 */
int main(void) { __builtin_trap(); /* UDF: undefined on purpose */ }
