# Builds each firmware/<name>/main.c into build/<name>.elf at the repo root.
#
#   make -C firmware          every program
#   make -C firmware blink    one program
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

PROGRAMS := $(patsubst %/main.c,%,$(wildcard */main.c))

all: $(PROGRAMS)

$(PROGRAMS): %: $(BUILD)/%.elf

$(BUILD)/%.elf: %/main.c $(COMMON) stm32g031k8.ld
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $< $(COMMON)

clean:
	rm -f $(PROGRAMS:%=$(BUILD)/%.elf)

.PHONY: all clean $(PROGRAMS)
