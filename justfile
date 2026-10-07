# List recipes
default:
    @just --list

# Run every *.test.ts
test:
    node --test

# Type-check without emitting
typecheck:
    npx tsc
