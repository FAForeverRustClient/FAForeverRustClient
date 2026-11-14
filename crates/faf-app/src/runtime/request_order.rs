//! Queue ordering for replaceable reads, independent of their owning feature.
use std::collections::HashMap;
use std::sync::Mutex;

pub(crate) enum ReadIntent {
    Start {
        lane: &'static str,
        key: String,
        request_id: Option<u32>,
    },
    Cancel {
        lanes: &'static [&'static str],
        key: String,
        request_id: Option<u32>,
    },
}

#[derive(Debug)]
struct Read {
    seq: u64,
    key: String,
    request_id: Option<u32>,
    cancelled: bool,
}

#[derive(Debug, Default)]
pub(crate) struct ReadOrder(Mutex<HashMap<&'static str, Read>>);

impl ReadOrder {
    #[cfg(test)]
    pub(super) fn poison_for_test(&self) {
        let _guard = self.0.lock().unwrap();
        panic!("simulated read bookkeeping panic");
    }

    #[cfg(test)]
    pub(super) fn is_poisoned_for_test(&self) -> bool {
        self.0.is_poisoned()
    }

    pub(crate) fn record(&self, seq: u64, intent: Option<ReadIntent>) {
        let Some(intent) = intent else {
            return;
        };
        let mut reads = super::lock_runtime(&self.0, "queued reads");
        match intent {
            ReadIntent::Start {
                lane,
                key,
                request_id,
            } => {
                if reads.get(lane).is_none_or(|current| current.seq < seq) {
                    reads.insert(
                        lane,
                        Read {
                            seq,
                            key,
                            request_id,
                            cancelled: false,
                        },
                    );
                }
            }
            ReadIntent::Cancel {
                lanes,
                key,
                request_id,
            } => {
                for lane in lanes {
                    if let Some(current) = reads.get_mut(lane).filter(|current| {
                        current.seq < seq
                            && current.key == key
                            && (request_id.is_none() || current.request_id == request_id)
                    }) {
                        current.cancelled = true;
                    }
                }
            }
        }
    }

    pub(crate) fn superseded(&self, seq: u64, intent: Option<ReadIntent>) -> Option<bool> {
        let ReadIntent::Start { lane, .. } = intent? else {
            return None;
        };
        Some(
            super::lock_runtime(&self.0, "queued reads")
                .get(lane)
                .is_none_or(|current| current.seq != seq || current.cancelled),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn start(key: &str, request_id: u32) -> Option<ReadIntent> {
        Some(ReadIntent::Start {
            lane: "test",
            key: key.into(),
            request_id: Some(request_id),
        })
    }
    fn cancel(key: &str, request_id: Option<u32>) -> Option<ReadIntent> {
        Some(ReadIntent::Cancel {
            lanes: &["test"],
            key: key.into(),
            request_id,
        })
    }

    #[test]
    fn queued_reads_preserve_identity_and_out_of_order_stamps() {
        let order = ReadOrder::default();
        order.record(2, start("new", 2));
        order.record(1, start("old", 1));
        assert_eq!(order.superseded(1, start("old", 1)), Some(true));
        order.record(3, cancel("old", None));
        order.record(4, cancel("new", Some(1)));
        assert_eq!(order.superseded(2, start("new", 2)), Some(false));
        order.record(5, cancel("new", Some(2)));
        assert_eq!(order.superseded(2, start("new", 2)), Some(true));
        order.record(7, start("new", 3));
        order.record(6, cancel("new", None));
        assert_eq!(order.superseded(7, start("new", 3)), Some(false));
    }
}
