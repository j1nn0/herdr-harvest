# Repository guidance

## Communication

- Use Japanese only for user-facing communication.
- Use English for all non-user-facing communication and generated artifacts unless the repository, task, or existing content requires another language.
- Use English for agent-to-agent communication, delegation prompts, plans, findings, summaries, intermediate reports, tool-related annotations, code comments, documentation, and commit messages.
- Keep non-user-facing communication concise and information-dense. Do not restate context already available to the receiving agent.
- Preserve the language of existing content when editing it unless the task explicitly requires changing it.

## Project Rules

## Architecture

## Commands

## Testing

## Coupled Changes

- Release → bump `version`, add a `## [x.y.z]` section to CHANGELOG.md (the release
  workflow extracts it by awk and fails the tag if `v<version>` does not match
  package.json), then push the tag.
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`, `ci:`, `test:`,
  `chore:`; `feat!:` for breaking changes).

## Validation

- Run `npm run check` after code changes.
