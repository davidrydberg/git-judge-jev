// One bundle, two ways in. GitHub runs it with no arguments inside a workflow, and that is the action.
// Anything else is the command line.
if (process.env.GITHUB_ACTIONS === "true" && process.argv.length <= 2) {
  void import("./action.js");
} else {
  void import("./cli.js").then(({ main }) =>
    main().catch((error: unknown) => {
      console.error(`git-judge-jev: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    }),
  );
}
