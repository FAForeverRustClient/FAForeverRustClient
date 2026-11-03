//! The rating a player is shown, made from the TrueSkill pair FAF sends.
//!
//! The lobby server, the API, the replay vault and a replay's own header all
//! describe a rating as a mean and a deviation. What players see, and compare
//! across clients and the website, is one number made from the two:
//! `mean - 3 * deviation`. This module is the one place that number is made.
//!
//! It was made in six places before, each with its own idea of rounding and
//! range, and they disagreed: a profile card that rounded showed a player as
//! 1986 while every lobby and replay showed 1985, and a lobby list that clamped
//! at zero showed 0 for an account whose own profile said -137.
//!
//! The rules, all of them deliberate:
//!
//! - **Truncated toward zero, never rounded.** Java's `RatingUtil.getRating` is
//!   `(int) (mean - 3f * deviation)` and the Python client's `rating_estimate`
//!   is `int(rating.displayed())`. Rounding put this client a point above both
//!   for every fraction over .5, and made a rating *change*, the difference of
//!   two of these, disagree by one in either direction.
//! - **Not clamped at zero.** A new or long-idle account has a deviation large
//!   enough to put the number below zero. That is a real number the player
//!   has: the server's own `displayed()` does not clamp it and the website
//!   prints it.
//! - **No number rather than a wrong one.** A pair that is not finite, or a
//!   result outside `i32`, gives `None` instead of a saturated or zeroed value.

/// `mean - 3 * deviation`, with its fraction, for the places that plot or
/// compare ratings rather than print them (the rating history graph, a game's
/// rating change).
pub fn displayed(mean: f64, deviation: f64) -> f64 {
    mean - 3.0 * deviation
}

/// A rating as the whole number a player is shown: truncated toward zero, not
/// clamped, and `None` when it is not finite or does not fit an `i32`.
///
/// For a value that is already `mean - 3 * deviation`, such as the scalar the
/// lobby server and the API send beside the pair. For the pair itself, use
/// [`displayed_points`].
pub fn whole_points(value: f64) -> Option<i32> {
    (value.is_finite() && value >= f64::from(i32::MIN) && value <= f64::from(i32::MAX))
        .then_some(value as i32)
}

/// The rating a player is shown for a TrueSkill pair.
pub fn displayed_points(mean: f64, deviation: f64) -> Option<i32> {
    whole_points(displayed(mean, deviation))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rating_is_truncated_towards_zero_like_both_reference_clients() {
        assert_eq!(displayed_points(1_500.5, 0.0), Some(1_500));
        assert_eq!(displayed_points(-1_500.5, 0.0), Some(-1_500));
        // 1985.78, the number a rounding profile card showed as 1986.
        assert_eq!(whole_points(1_985.78), Some(1_985));
        assert_eq!(displayed_points(2_000.0, 150.0), Some(1_550));
    }

    #[test]
    fn a_rating_below_zero_is_shown_as_it_is() {
        assert_eq!(displayed_points(500.0, 212.4), Some(-137));
    }

    #[test]
    fn no_number_is_shown_rather_than_a_wrong_one() {
        assert_eq!(displayed_points(f64::NAN, 0.0), None);
        assert_eq!(displayed_points(f64::INFINITY, 0.0), None);
        assert_eq!(displayed_points(1_500.0, f64::NAN), None);
        assert_eq!(whole_points(f64::from(i32::MAX) * 2.0), None);
        assert_eq!(whole_points(f64::from(i32::MIN) * 2.0), None);
    }

    #[test]
    fn the_unrounded_value_keeps_its_fraction() {
        assert_eq!(displayed(1_600.25, 50.0), 1_450.25);
    }
}
