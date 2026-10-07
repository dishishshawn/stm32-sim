# List recipes
default:
    @just --list

# Install the dependencies, and Chromium for the UI tests (once, after cloning)
setup:
    npm ci
    npx playwright-core install --only-shell --no-remove chromium

# Build the firmware, `npm ci` on a fresh clone, and open the thermometer in your browser (`just demo --port 0` if 8031 is taken)
demo *args: fw
    [ -d node_modules ] || npm ci
    node src/cli/sim.ts ui build/thermometer.elf --circuit firmware/thermometer/circuit.json --open {{ args }}

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
