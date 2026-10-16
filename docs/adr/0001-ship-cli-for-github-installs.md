# Run source code for GitHub installs

pnpm can block build scripts for GitHub installs. We ship source files and a JavaScript launcher instead of a compiled file in Git. The launcher uses `tsx` when it cannot find `dist/cli.js`. npm packages use the compiled file.
