export const SUMMARY_SYSTEM = `You are a session summarizer for an AI coding agent's memory system. Given all compressed observations from a coding session, produce a concise session summary that future agents will retrieve when looking for context on past work.

Output EXACTLY this XML format with no additional text:

<summary>
  <title>Short session title (max 100 chars). Include the PRIMARY subject (project, task, feature) — this is the primary search hit.</title>
  <narrative>3-5 sentence narrative of what was accomplished and why. Start with the single most important decision or outcome so it lands first in the search snippet.</narrative>
  <tags>
    <tag>short searchable tag</tag>
  </tags>
  <decisions>
    <decision>Key technical decision made</decision>
  </decisions>
  <files>
    <file>path/to/modified/file</file>
  </files>
  <concepts>
    <concept>key concept from session</concept>
  </concepts>
</summary>

Rules:
- Focus on outcomes, not individual tool calls
- Highlight decisions and their rationale
- List all files that were created or modified
- Concepts AND tags should be searchable terms for future context retrieval
- Tags: short (1-2 words), 3-5 of them, mix of domain + operation type
  (e.g., "VASP", "cleanup", "refactor", "bugfix", "performance")
- The narrative should read like a commit message a human would write
- The narrative's first sentence should answer "what did this session decide/accomplish" — search snippets cut at ~150 chars, so lead with the answer`;

export function buildSummaryPrompt(observations: Array<{
  type: string
  title: string
  facts: string[]
  narrative: string
  files: string[]
  concepts: string[]
}>): string {
  const lines = observations.map((obs, i) => {
    const facts = obs.facts.map((f) => `  - ${f}`).join('\n')
    return `[${i + 1}] ${obs.type}: ${obs.title}\n${obs.narrative}\nFacts:\n${facts}\nFiles: ${obs.files.join(', ')}`
  })
  return `Session observations (${observations.length} total):\n\n${lines.join('\n\n---\n\n')}`
}

export const REDUCE_SYSTEM = `You are merging multiple partial summaries of the SAME coding session into one final session summary. The partials are chronological chunks of one continuous session — not separate sessions.

Output EXACTLY this XML format with no additional text:

<summary>
  <title>Short session title (max 100 chars). Should capture the session's overall outcome — what would a future agent search for to find this work?</title>
  <narrative>3-5 sentence narrative covering the whole session arc, not chunk-by-chunk. Lead with the single most important decision or outcome.</narrative>
  <tags>
    <tag>short searchable tag</tag>
  </tags>
  <decisions>
    <decision>Key technical decision made</decision>
  </decisions>
  <files>
    <file>path/to/modified/file</file>
  </files>
  <concepts>
    <concept>key concept from session</concept>
  </concepts>
</summary>

Rules:
- Synthesize a single narrative that reflects the whole arc, not a chunk-by-chunk recap
- Preserve every distinct decision across chunks
- Union (deduplicate) all files, concepts, and tags
- Title should capture the session's overall outcome
- Tags: 3-5 short searchable terms (domain + operation type)
- Later chunks override earlier ones when they contradict (override semantics)`;

export function buildReducePrompt(partials: Array<{
  title: string
  narrative: string
  keyDecisions: string[]
  filesModified: string[]
  concepts: string[]
  obsRangeStart: number
  obsRangeEnd: number
}>): string {
  const sections = partials.map((p, i) => {
    const decisions = p.keyDecisions.map((d) => `  - ${d}`).join('\n')
    const files = p.filesModified.map((f) => `  - ${f}`).join('\n')
    const concepts = p.concepts.join(', ')
    return `[Chunk ${i + 1} of ${partials.length} — obs ${p.obsRangeStart}-${p.obsRangeEnd}]
Title: ${p.title}
Narrative: ${p.narrative}
Decisions:
${decisions}
Files:
${files}
Concepts: ${concepts}`
  })
  return `Partial summaries (${partials.length} chunks of one session, chronological):\n\n${sections.join('\n\n---\n\n')}`
}
