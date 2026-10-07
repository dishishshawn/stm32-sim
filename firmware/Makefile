# Builds each firmware/<name>/main.c into build/<name>.elf at the repo root, and
# each firmware/<group>/<name>/main.c into build/<group>/<name>.elf.
#
#   make -C firmware          every program
#   make -C firmware blink    one program (or faults/gpio-clock)
#   make -C firmware clean
#
# `just fw` runs the first one.

BUILD  := ../build
DEVICE := ../vendor/cmsis-device-g0
CORE   := ../vendor/cmsis-core

CC := arm-none-eabi-gcc

# -Og: optimise without making the code hard to follow in a debugger.
# -ffunction-sections/-fdata-sections + --gc-sections drop unused functions.
CFLAGS := -mcpu=cortex-m0plus -mthumb -g -Og \
          -Wall -Wextra -ffunction-sections -fdata-sections \
          -DSTM32G031xx -I$(DEVICE) -I$(CORE)

# The startup code calls the C library's __libc_init_array, so link newlib-nano.
# A program that uses printf or malloc will also need --specs=nosys.specs (or its
# own _write/_sbrk); blink doesn't, and nosys adds linker warnings.
LDFLAGS := -T stm32g031k8.ld --specs=nano.specs -Wl,--gc-sections

# Linked into every program: the vector table and reset code, and SystemInit.
COMMON := $(DEVICE)/startup_stm32g031xx.s $(DEVICE)/system_stm32g0xx.c

PROGRAMS := $(patsubst %/main.c,%,$(wildcard */main.c */*/main.c))

all: $(PROGRAMS) ../compile_commands.json

$(PROGRAMS): %: $(BUILD)/%.elf

# For clangd: compile_commands.json at the repo root (gitignored: absolute paths).
# clangd doesn't ask arm-none-eabi-gcc where its system headers are (stdint.h,
# ...), so they are listed with -isystem, taken from gcc's own search path.
SYSINC := $(shell $(CC) -xc -E -Wp,-v /dev/null 2>&1 | sed -n 's|^ \(/.*\)|-isystem \1|p')

../compile_commands.json: Makefile $(PROGRAMS:%=%/main.c)
	@{ echo '['; for f in $(PROGRAMS:%=%/main.c) $(DEVICE)/system_stm32g0xx.c; do \
	  echo "  {\"directory\": \"$(CURDIR)\", \"file\": \"$$f\", \"command\": \"$(CC) $(CFLAGS) $(SYSINC) -c $$f\"},"; \
	done; } | sed '$$ s/,$$//' > $@ && echo ']' >> $@

$(BUILD)/%.elf: %/main.c $(COMMON) stm32g031k8.ld
	@mkdir -p $(@D)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $< $(COMMON)

clean:
	rm -f $(PROGRAMS:%=$(BUILD)/%.elf)

.PHONY: all clean $(PROGRAMS)
