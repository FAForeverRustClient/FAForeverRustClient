//! Lock access that survives a panic somewhere else.
//!
//! A `std::sync` lock is poisoned when a thread panics while holding it, and
//! `.lock().unwrap()` then panics on every later access. One panicking
//! command used to turn each lock it held into a panic for every command
//! after it, for the rest of the session. These locks guard caches, handles
//! and session bookkeeping, where carrying on with the last value written is
//! better than failing every access, so the recovery takes the guard, clears
//! the poison and logs the incident once, as the runtime's own locks do.

use std::panic::Location;
use std::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};

/// [`Mutex::lock`] that recovers from poisoning instead of panicking.
pub trait LockExt<T: ?Sized> {
    fn lock_or_recover(&self) -> MutexGuard<'_, T>;
}

/// [`RwLock::read`] and [`RwLock::write`] that recover from poisoning.
pub trait RwLockExt<T: ?Sized> {
    fn read_or_recover(&self) -> RwLockReadGuard<'_, T>;
    fn write_or_recover(&self) -> RwLockWriteGuard<'_, T>;
}

impl<T: ?Sized> LockExt<T> for Mutex<T> {
    #[track_caller]
    fn lock_or_recover(&self) -> MutexGuard<'_, T> {
        let caller = Location::caller();
        self.lock().unwrap_or_else(|poison| {
            // Cleared while the recovered guard is held, so the next access
            // neither logs the same incident again nor sees it as poisoned.
            let guard = poison.into_inner();
            self.clear_poison();
            log_recovery(caller);
            guard
        })
    }
}

impl<T: ?Sized> RwLockExt<T> for RwLock<T> {
    #[track_caller]
    fn read_or_recover(&self) -> RwLockReadGuard<'_, T> {
        let caller = Location::caller();
        self.read().unwrap_or_else(|poison| {
            let guard = poison.into_inner();
            self.clear_poison();
            log_recovery(caller);
            guard
        })
    }

    #[track_caller]
    fn write_or_recover(&self) -> RwLockWriteGuard<'_, T> {
        let caller = Location::caller();
        self.write().unwrap_or_else(|poison| {
            let guard = poison.into_inner();
            self.clear_poison();
            log_recovery(caller);
            guard
        })
    }
}

fn log_recovery(caller: &Location<'_>) {
    tracing::error!(
        location = %caller,
        "recovered a lock poisoned by an earlier panic; the interrupted operation may be incomplete"
    );
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    fn poison_with<L: Send + Sync + 'static>(lock: Arc<L>, hold: fn(&L)) {
        let held = lock.clone();
        let outcome = std::thread::spawn(move || {
            hold(&held);
        })
        .join();
        assert!(outcome.is_err(), "the holder panicked");
    }

    #[test]
    fn a_poisoned_mutex_keeps_its_value_and_is_cleared() {
        let lock = Arc::new(Mutex::new(1));
        poison_with(lock.clone(), |lock| {
            let mut value = lock.lock().unwrap();
            *value = 2;
            panic!("simulated panic while holding the lock");
        });
        assert!(lock.is_poisoned());

        assert_eq!(*lock.lock_or_recover(), 2);
        assert!(!lock.is_poisoned(), "one incident is recovered once");
        assert_eq!(*lock.lock().unwrap(), 2);
    }

    #[test]
    fn a_poisoned_rwlock_recovers_for_readers_and_writers() {
        let lock = Arc::new(RwLock::new(1));
        poison_with(lock.clone(), |lock| {
            let _value = lock.write().unwrap();
            panic!("simulated panic while holding the lock");
        });

        assert_eq!(*lock.read_or_recover(), 1);
        assert!(!lock.is_poisoned());

        poison_with(lock.clone(), |lock| {
            let _value = lock.write().unwrap();
            panic!("simulated panic while holding the lock");
        });
        *lock.write_or_recover() = 3;
        assert!(!lock.is_poisoned());
        assert_eq!(*lock.read().unwrap(), 3);
    }
}
