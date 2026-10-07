# List recipes
default:
    @just --list

# Run every *.test.ts
test:
    node --test

# Type-check without emitting
typecheck:
    npx tsc

# Build every firmware/<name>/main.c into build/<name>.elf (needs arm-none-eabi-gcc)
fw:
    make -C firmware

# Run the CLI from the current directory, e.g. `just sim run build/blink.elf --for 2s`
[no-cd]
sim *args:
    @node {{ justfile_directory() }}/src/cli/sim.ts {{ args }}
