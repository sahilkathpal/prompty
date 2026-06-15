#import "ObjCException.h"

BOOL ocx_try(NS_NOESCAPE void (^block)(void), NSError *_Nullable *_Nullable error) {
    @try {
        block();
        return YES;
    } @catch (NSException *exception) {
        if (error) {
            NSMutableDictionary *info = [NSMutableDictionary dictionary];
            info[NSLocalizedDescriptionKey] = exception.reason ?: exception.name;
            info[@"ExceptionName"] = exception.name;
            if (exception.userInfo) {
                info[@"ExceptionUserInfo"] = exception.userInfo;
            }
            *error = [NSError errorWithDomain:@"ObjCException" code:0 userInfo:info];
        }
        return NO;
    }
}
