#!/usr/bin/env node

// Dispatcher script for running different examples
// Usage:
//   yarn example           - Run basic example (default)
//   yarn example [type]    - Run a specific example
//
// Types:
//   basic       Basic dice rolling and query examples
//   stats       Advanced statistics and probability analysis
//   sneakattack Sneak attack stress test examples
//   misc        Miscellaneous examples
//   list        Show detailed descriptions

const arg = process.argv[2];

async function runExample(modulePath: string, message: string) {
  console.log(`${message}\n`);
  await import(modulePath);
}

function showList() {
  console.log("Available Examples:\n");
  console.log("  basic       - Basic dice rolling and query examples");
  console.log(
    "                Shows basic dice notation, simple rolls, and probability queries\n"
  );

  console.log("  stats       - Advanced statistics and probability analysis");
  console.log(
    "                Displays detailed statistical tables, PMF/CDF charts, and outcome breakdowns\n"
  );

  console.log("  sneakattack - Sneak attack examples");
  console.log(
    "                Implements the same conditional damage rider approach in multiple ways."
  );
  console.log(
    "                This stress tests the underlying PMF implementation.\n"
  );

  console.log("  misc        - Miscellaneous examples");
  console.log("                A collection of many random examples\n");

  console.log("Usage:");
  console.log("  yarn example           - Run basic example (default)");
  console.log("  yarn example [type]    - Run a specific example\n");
}

(async () => {
  switch (arg) {
    case "stats":
      await runExample("./statistics-example", "Running statistics example...");
      break;

    case "misc":
      await runExample("./other-examples", "Running miscellaneous examples...");
      break;

    case "basic":
      await runExample("./basic-usage", "Running basic usage example...");
      break;

    case "sneakattack":
      await runExample(
        "./sneak-attack-examples",
        "Running sneak attack examples..."
      );
      break;

    case "list":
      showList();
      break;

    case undefined:
      // Default to basic usage when no argument is provided
      await runExample(
        "./basic-usage",
        "Running basic usage example (default)..."
      );
      break;

    default:
      console.error(`Unknown example type: ${arg}\n`);
      showList();
      process.exit(1);
  }
})();
