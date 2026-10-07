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
