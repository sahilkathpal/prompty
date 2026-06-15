#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Runs `block`, converting any raised Objective-C `NSException` into an
/// `NSError` (domain `ObjCException`). Returns `YES` if the block completed
/// normally, `NO` if an exception was caught (and `*error` is populated).
///
/// Swift's `do`/`catch` only handles Swift `Error`s — it cannot catch an ObjC
/// `NSException`, which instead unwinds straight through Swift frames to
/// `abort()` (SIGABRT). Several AVAudioEngine calls (notably `installTap`) raise
/// such exceptions when the hardware audio format flips mid-session (e.g. a
/// Bluetooth headset switching A2DP→HFP). Routing those calls through this shim
/// turns an uncatchable crash into a recoverable error.
BOOL ocx_try(NS_NOESCAPE void (^block)(void), NSError *_Nullable *_Nullable error);

NS_ASSUME_NONNULL_END
