# Session study notes — design

Date: 2026-11-07. Origin: the learner asked, in a chat, for intuition without formulas; later in Practice the exercises came back full of formulas. The preference was a remark about *how* to study, not a fact, so extraction never put it in the graph and Practice never saw it.

## Design

- Each chat has at most one **study note**: a few plain lines about how the learner wants to study what that chat teaches (level, formulas yes or no, preferred kinds of example). Stored in `data/ext/session-notes.json` as `{ [chatId]: { text, updatedAt, edited } }`.
- The note is written by an extension stage that runs after the existing extraction merge (the pattern verification already uses): a cheap model call reads the chunk of transcript just extracted and, only from the learner's own words, updates the note. It never writes into the graph. If the learner edited the note by hand (`edited: true`), the stage proposes nothing over it.
- Nodes already carry provenance (the chats that produced them). Any session that works on a node (Practice, review, office hours, exercises) receives the notes of the node's source chats next to the node.
- The learner sees and edits the note in the node panel ("How you wanted to study this"), and can clear it.

## Requirements

- **REQ-sn-01**: `session-notes.json` holds at most one note per chat, text bounded to 1000 characters; contract documented in CONTRACTS.md.
- **REQ-sn-02**: After an extraction run of a real chat, a stage updates that chat's note from the learner's own messages in the extracted chunk only; it makes no change when the chunk holds no statement about how to study.
- **REQ-sn-03**: The stage's spend is counted on the shared daily cost gate; when the gate is closed or the model is unavailable it does nothing.
- **REQ-sn-04**: A note the learner edited is never overwritten by the stage.
- **REQ-sn-05**: A session working on a node receives the notes of the node's provenance chats, labelled as the learner's study preferences, ahead of the node text; text in a note is data, not instructions to other tools.
- **REQ-sn-06**: The node panel shows the notes of the node's source chats and lets the learner edit or clear each.

## Security Profile

**Level:** baseline (inherited from the parent spec)

**Active practices:** architectural-mapping (always on), design-by-contract (note bounds, edited flag), adversarial-test-writing, static-analysis-hardening.

**Explicitly excluded:** mutation-testing (user decision 2026-11-05), requirements-traceability-matrix, mcdc-coverage, system-safety-analysis, watchdog-safe-state, lightweight-wcet (not applicable).

**Set:** 2026-11-07, inherited from the parent spec.
