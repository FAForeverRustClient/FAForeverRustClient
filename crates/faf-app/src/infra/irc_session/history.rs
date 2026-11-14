use super::*;

pub(super) fn decide(line: &irc::IrcLine, state: &mut SessionState) -> Vec<Effect> {
    let effects = Vec::new();
    if let Some(batch) = line.params.first() {
        if let Some(id) = batch.strip_prefix('-') {
            state.history_batches.remove(id);
        } else if let Some(id) = batch.strip_prefix('+') {
            // A batch inside a history batch belongs to that history.
            let outer = line
                .tag("batch")
                .and_then(|outer| state.history_batches.get(outer))
                .cloned();
            let history = line
                .params
                .get(1)
                .is_some_and(|kind| kind.contains("chathistory"));
            let root = outer.or_else(|| history.then(|| id.to_string()));
            if let Some(root) = root.filter(|_| state.history_batches.len() < 64) {
                if root == id {
                    let target = line.params.get(2).cloned().unwrap_or_default();
                    let request = state
                        .history_requests
                        .remove(&target.to_ascii_lowercase())
                        .unwrap_or_else(|| HistoryRequest {
                            limit: latest_history_lines(&target),
                            channel: target,
                            earlier: false,
                        });
                    state
                        .history_answers
                        .insert(id.to_string(), HistoryAnswer { request, lines: 0 });
                }
                state.history_batches.insert(id.to_string(), root);
            }
        }
    }
    effects
}
