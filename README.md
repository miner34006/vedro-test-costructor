# vedro-test-constructor

This is a Visual Studio Code extension for the Vedro framework, designed to help you construct tests from already available steps in workspace.

## Features

- Easily create and manage tests using the Vedro framework.
- Utilize pre-existing steps to build comprehensive test cases.
- Integrated with VSCode for a seamless development experience.

## Usage

Use the command palette (`Ctrl+Shift+P` or `Cmd+Shift+P` on macOS) and search for:
- `Vedro: Enable CodeLens` - enable codelens hints above your test steps;
- `Vedro: Disable CodeLens` - disable codelens hints above your test steps;
- `Vedro: Reset cache` - reset cache in case new folders or tests were added to exisiting workspace.

### Hints

Hints are available above test functions with names started with `[given|when|then|and]`

- `Search [given|when|then|and]` - search among all previously written steps with same prefix;
- `Search similar [given|when|then|and]` - search among all previously written steps with same prefix with similar names.
