Review the conversation history and improve project instructions.

Reference files:

- Project conventions: @CLAUDE.md
- Code reviewer agent: @.claude/agents/code-reviewer.md
- Instructions editor agent: @.claude/agents/instructions-editor.md
- Deps updater agent: @.claude/agents/deps-updater.md

## Process

1. **Scan the conversation** — read the full conversation history from this session. Identify every instance where:
    - The user corrected your behavior or pointed out a mistake.
    - A convention was established or clarified through discussion (not just documented).
    - A workaround was needed because tooling didn't catch something.
    - A pattern emerged that isn't yet captured in instructions.

2. **Extract findings** — for each finding, note:
    - What happened (the specific correction or pattern).
    - Whether it's already documented in CLAUDE.md, agent prompts, or Serena memory.
    - If not documented, what rule or principle would prevent it in the future.

3. **Categorize gaps** — group undocumented findings into:
    - **Tooling gaps** — things a tool should catch but doesn't (fix the tool config).
    - **Convention gaps** — judgment calls that should be in CLAUDE.md.
    - **Review gaps** — patterns the code-reviewer agent should check (add to `.claude/agents/code-reviewer.md`).
    - **Agent gaps** — improvements to other agent prompts (deps-updater, etc.).

4. **Present findings** — show the user a summary of what you found, organized by category. For each item, propose the specific change to instructions or config.

5. **Run instructions-editor review** — before applying changes, use the instructions-editor agent (via Task tool) to review all proposed changes for consistency, completeness, and redundancy. Present the editor's feedback to the user alongside your proposals. Wait for user approval before making changes.

6. **Apply approved changes** — update CLAUDE.md, agent prompts (`.claude/agents/`), and Serena memory as needed. If a tooling gap was found, fix the relevant config. Run `mise run check` to verify nothing breaks.
