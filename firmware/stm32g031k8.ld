/*
 * Linker script for the STM32G031K8: where each piece of the program goes.
 *
 * Code and constants live in flash. Variables live in RAM. Variables with a
 * starting value (.data) are stored in flash too, and the startup code
 * (vendor/cmsis-device-g0/startup_stm32g031xx.s) copies them into RAM before
 * main() runs. It also zeroes .bss. The symbols it uses for that (_sidata,
 * _sdata, _edata, _sbss, _ebss, _estack) are defined here.
 */

/* The first instruction to run after reset. The CPU actually finds it through
   the vector table, but the ELF records it too, and --gc-sections starts here. */
ENTRY(Reset_Handler)

MEMORY
{
  FLASH (rx)  : ORIGIN = 0x08000000, LENGTH = 64K
  RAM   (rwx) : ORIGIN = 0x20000000, LENGTH = 8K
}

/* The stack starts at the top of RAM and grows down, towards .bss. */
_estack = ORIGIN(RAM) + LENGTH(RAM);

/* Stop the link if RAM can't keep at least this much free for the stack. */
_Min_Stack_Size = 1K;

SECTIONS
{
  /* The vector table must be first in flash: at reset the CPU reads the
     initial stack pointer from 0x08000000 and the reset address from
     0x08000004. KEEP stops --gc-sections removing it, since no code refers
     to it. */
  .isr_vector :
  {
    KEEP(*(.isr_vector))
  } > FLASH

  /* Program code. .init and .fini come from the C library's startup files. */
  .text :
  {
    *(.text*)
    KEEP(*(.init))
    KEEP(*(.fini))
  } > FLASH

  /* Constants: string literals, const tables. */
  .rodata :
  {
    *(.rodata*)
  } > FLASH

  /* Tables of constructor/destructor addresses. The startup code calls the C
     library's __libc_init_array, which walks them. Plain C leaves them almost
     empty, but the symbols must exist. */
  .preinit_array :
  {
    PROVIDE_HIDDEN(__preinit_array_start = .);
    KEEP(*(.preinit_array*))
    PROVIDE_HIDDEN(__preinit_array_end = .);
  } > FLASH

  .init_array :
  {
    PROVIDE_HIDDEN(__init_array_start = .);
    KEEP(*(SORT(.init_array.*)))
    KEEP(*(.init_array*))
    PROVIDE_HIDDEN(__init_array_end = .);
  } > FLASH

  .fini_array :
  {
    PROVIDE_HIDDEN(__fini_array_start = .);
    KEEP(*(SORT(.fini_array.*)))
    KEEP(*(.fini_array*))
    PROVIDE_HIDDEN(__fini_array_end = .);
    /* The startup code copies .data a word at a time, so its flash copy,
       which comes next, must start on a 4-byte boundary. */
    . = ALIGN(4);
  } > FLASH

  /* Initialised variables. They run from RAM (> RAM) but their starting
     values are stored in flash (AT > FLASH), at address _sidata. */
  _sidata = LOADADDR(.data);

  .data :
  {
    . = ALIGN(4);
    _sdata = .;
    *(.data*)
    . = ALIGN(4);
    _edata = .;
  } > RAM AT > FLASH

  /* Variables that start at zero. They take no space in flash. */
  .bss :
  {
    . = ALIGN(4);
    _sbss = .;
    *(.bss*)
    *(COMMON)
    . = ALIGN(4);
    _ebss = .;
  } > RAM

  ASSERT(_ebss + _Min_Stack_Size <= _estack, "not enough RAM left for the stack")
}
