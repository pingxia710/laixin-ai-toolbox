// Privileged proxy-only capability. No client-supplied executable, shell, path or UID.
#import <Foundation/Foundation.h>
#import <SystemConfiguration/SystemConfiguration.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/ucred.h>
#include <sys/proc.h>
#include <libproc.h>
#include <poll.h>
#include <fcntl.h>
#include <signal.h>
#include <unistd.h>
#include <mach-o/dyld.h>

#ifndef LAIXIN_PROXY_FIXTURE
#define HELPER_ROOT @"/Library/PrivilegedHelperTools/com.laixin.toolbox.proxy"
#else
#define HELPER_ROOT @LAIXIN_PROXY_FIXTURE
#endif
static NSString *const Label = @"com.laixin.toolbox.proxy";
static NSString *const Permission = @"TUNNEL_PROXY_AUTH_REQUIRED";
static NSString *const Failed = @"TUNNEL_PROXY_HELPER_FAILED";
static volatile sig_atomic_t stopping;
static volatile sig_atomic_t activeFD = -1;
static int listeningFD = -1;
static NSMutableDictionary *journal;
static NSString *configurationFailureReason;
static int configurationFailureCode;
static void logStage(const char *stage, int code) {
    fprintf(stderr, "time=%.3f pid=%d stage=%s code=%d\n", NSDate.date.timeIntervalSince1970, getpid(), stage, code);
    fflush(stderr);
}
static BOOL __attribute__((unused)) configurationFailed(NSString *reason, int code) {
    configurationFailureReason = reason;
    configurationFailureCode = code;
    return NO;
}

static NSString *path(NSString *name) { return [HELPER_ROOT stringByAppendingPathComponent:name]; }
static NSDictionary *failure(NSString *code) { return @{ @"ok": @NO, @"code": code }; }
static NSDictionary *success(void) { return @{ @"ok": @YES, @"version": @3 }; }
static NSDictionary *failureReason(NSString *code, NSString *reason, int systemCode) {
    return @{ @"ok": @NO, @"code": code, @"reason": reason, @"systemCode": @(systemCode) };
}
static BOOL dictionary(id value) { return [value isKindOfClass:NSDictionary.class]; }
static BOOL string(id value) { return [value isKindOfClass:NSString.class]; }
static void onSignal(int sig) { (void)sig; stopping = 1; }
static void onDeadline(int sig) {
    (void)sig;
    // Only async-signal-safe calls. Do not unwind a possibly blocked SC transaction.
    static const char message[] = "stage=operation-timeout exit=75\n";
    static const char reply[] = "{\"ok\":false,\"code\":\"TUNNEL_PROXY_HELPER_FAILED\",\"reason\":\"TIMEOUT\"}";
    write(STDERR_FILENO, message, sizeof(message) - 1);
    if (activeFD >= 0) write(activeFD, reply, sizeof(reply) - 1);
    _exit(75); // launchd restarts; the durable write-ahead journal remains intact.
}

static BOOL savePlist(id value, NSString *file) {
    NSError *error = nil;
    NSData *data = [NSPropertyListSerialization dataWithPropertyList:value format:NSPropertyListBinaryFormat_v1_0 options:0 error:&error];
    if (!data || ![data writeToFile:file options:NSDataWritingAtomic error:&error]) return NO;
    int fd = open(file.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW);
    if (fd < 0) return NO;
    BOOL ok = fchmod(fd, 0600) == 0 && fsync(fd) == 0;
    close(fd);
    // Persist the atomic rename as well as the file before any system mutation.
    fd = open(HELPER_ROOT.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (fd < 0) return NO;
    ok = fsync(fd) == 0 && ok;
    close(fd);
    return ok;
}

static NSDictionary *processIdentity(pid_t pid) {
    struct proc_bsdinfo info = {0};
    if (pid <= 1 || proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) return nil;
    if (info.pbi_status == SZOMB) return nil;
    return @{ @"pid": @(pid), @"seconds": @(info.pbi_start_tvsec), @"micros": @(info.pbi_start_tvusec) };
}

static NSArray *keysFor(NSString *item) {
    if ([item isEqual:@"web-proxy"]) return @[@"HTTPEnable", @"HTTPProxy", @"HTTPPort"];
    if ([item isEqual:@"secure-web-proxy"]) return @[@"HTTPSEnable", @"HTTPSProxy", @"HTTPSPort"];
    if ([item isEqual:@"socks-proxy"]) return @[@"SOCKSEnable", @"SOCKSProxy", @"SOCKSPort"];
    if ([item isEqual:@"auto-proxy"]) return @[@"ProxyAutoConfigEnable", @"ProxyAutoConfigURLString"];
    return nil;
}
static NSDictionary *subset(NSDictionary *config, NSArray *keys) {
    NSMutableDictionary *result = [NSMutableDictionary dictionary];
    for (NSString *key in keys) if (config[key]) result[key] = config[key];
    return result;
}
static NSDictionary *merging(NSDictionary *config, NSArray *keys, NSDictionary *value) {
    NSMutableDictionary *result = [config mutableCopy];
    for (NSString *key in keys) [result removeObjectForKey:key];
    [result addEntriesFromDictionary:value];
    return result;
}

#if !defined(LAIXIN_PROXY_FIXTURE) || defined(LAIXIN_PROXY_REAL_SC_FIXTURE)
// Names are scoped to the active network location. Recovery uses the stable ID
// directly, so services left behind by an old location cannot create ambiguity.
static SCNetworkServiceRef copyService(SCPreferencesRef prefs, NSString *name, BOOL byID, BOOL *ambiguous) {
    *ambiguous = NO;
    if (byID) {
        SCNetworkServiceRef service = SCNetworkServiceCopy(prefs, (__bridge CFStringRef)name);
        if (!service) {
            int code = SCError(); logStage("service-id-not-found", code);
            configurationFailed(@"SERVICE_NOT_FOUND", code);
        }
        return service;
    }
    SCNetworkSetRef current = SCNetworkSetCopyCurrent(prefs);
    if (!current) {
        int code = SCError(); logStage("current-set-not-found", code);
        configurationFailed(@"CURRENT_SET_NOT_FOUND", code);
        return NULL;
    }
    CFArrayRef services = SCNetworkSetCopyServices(current);
    if (!services) {
        int code = SCError(); logStage("current-set-services-failed", code);
        configurationFailed(@"CURRENT_SET_SERVICES_FAILED", code);
        CFRelease(current);
        return NULL;
    }
    SCNetworkServiceRef found = NULL;
    for (CFIndex index = 0; index < CFArrayGetCount(services); index += 1) {
        SCNetworkServiceRef service = (SCNetworkServiceRef)CFArrayGetValueAtIndex(services, index);
        CFStringRef candidate = SCNetworkServiceGetName(service);
        if ([(__bridge NSString *)candidate isEqual:name]) {
            if (found) {
                CFRelease(found); found = NULL; *ambiguous = YES; break;
            }
            found = (SCNetworkServiceRef)CFRetain(service);
        }
    }
    CFRelease(services);
    CFRelease(current);
    if (*ambiguous) {
        int code = SCError(); logStage("current-service-ambiguous", code);
        configurationFailed(@"SERVICE_AMBIGUOUS", code);
    } else if (!found) {
        int code = SCError(); logStage("current-service-not-found", code);
        configurationFailed(@"SERVICE_NOT_FOUND", code);
    }
    return found;
}
#endif

// Lock, read, compare and commit are one SystemConfiguration transaction. Fixture
// builds replace ONLY this boundary, and cannot be shipped by the build script.
static BOOL withService(NSString *name, BOOL byID, BOOL (^operation)(NSString *, NSDictionary *, BOOL (^)(NSDictionary *))) {
    configurationFailureReason = @"SYSTEM_CONFIGURATION";
    configurationFailureCode = 0;
#ifdef LAIXIN_PROXY_FIXTURE
    NSString *fault = [NSString stringWithContentsOfFile:path(@"fault") encoding:NSUTF8StringEncoding error:nil];
    if ([fault isEqual:@"exception"]) @throw [NSException exceptionWithName:@"FixtureRequest" reason:nil userInfo:nil];
    if ([fault isEqual:@"hang"]) for (;;) pause();
    if ([fault isEqual:@"listener"]) { close(listeningFD); return NO; }
#endif
#if defined(LAIXIN_PROXY_FIXTURE) && !defined(LAIXIN_PROXY_REAL_SC_FIXTURE)
    (void)byID;
    NSMutableDictionary *services = [[NSDictionary dictionaryWithContentsOfFile:path(@"system/services.plist")] mutableCopy];
    if (!dictionary(services[name])) return NO;
    return operation(name, services[name], ^BOOL(NSDictionary *next) {
        services[name] = next;
        BOOL ok = savePlist(services, path(@"system/services.plist"));
        if (ok && [fault isEqual:@"commit-hang"]) for (;;) pause();
        return ok;
    });
#else
    SCPreferencesRef prefs = SCPreferencesCreate(NULL, CFSTR("Laixin Proxy Helper"),
#ifdef LAIXIN_PROXY_REAL_SC_FIXTURE
        (__bridge CFStringRef)path(@"system/services.plist")
#else
        NULL
#endif
    );
    if (!prefs) { int code = SCError(); logStage("preferences-create-failed", code); return configurationFailed(@"PREFERENCES_CREATE_FAILED", code); }
    if (!SCPreferencesLock(prefs, false)) {
        int code = SCError(); logStage("preferences-lock-failed", code); CFRelease(prefs);
        return configurationFailed(@"PREFERENCES_LOCK_FAILED", code);
    }
    BOOL ambiguous = NO;
    SCNetworkServiceRef found = copyService(prefs, name, byID, &ambiguous);
    BOOL ok = NO;
    SCNetworkProtocolRef protocol = NULL;
    @try {
    if (found && !ambiguous) {
        // HTTP, HTTPS, SOCKS and PAC are keys in this single protocol dictionary.
        // Use the literal value across old macOS SDK/runtime combinations.
        protocol = SCNetworkServiceCopyProtocol(found, CFSTR("Proxies"));
        if (!protocol) {
            int copyCode = SCError();
            logStage("proxies-protocol-missing", copyCode);
            if (!SCNetworkServiceAddProtocolType(found, CFSTR("Proxies"))) {
                int code = SCError(); logStage("proxies-protocol-add-failed", code);
                configurationFailed(@"PROXIES_PROTOCOL_ADD_FAILED", code);
            } else {
                logStage("proxies-protocol-added", 0);
                protocol = SCNetworkServiceCopyProtocol(found, CFSTR("Proxies"));
                if (!protocol) {
                    int code = SCError(); logStage("proxies-protocol-copy-failed", code);
                    configurationFailed(@"PROXIES_PROTOCOL_COPY_FAILED", code);
                }
            }
        }
        if (protocol) {
            NSDictionary *config = (__bridge NSDictionary *)SCNetworkProtocolGetConfiguration(protocol);
            NSString *serviceID = (__bridge NSString *)SCNetworkServiceGetServiceID(found);
            ok = operation(serviceID, config ?: @{}, ^BOOL(NSDictionary *next) {
                logStage("preferences-set", 0);
                if (!SCNetworkProtocolSetConfiguration(protocol, (__bridge CFDictionaryRef)next)) {
                    int code = SCError(); logStage("preferences-set-failed", code);
                    return configurationFailed(@"PROXIES_SET_FAILED", code);
                }
                logStage("preferences-commit", 0);
                if (!SCPreferencesCommitChanges(prefs)) {
                    int code = SCError(); logStage("preferences-commit-failed", code);
                    return configurationFailed(@"PREFERENCES_COMMIT_FAILED", code);
                }
                logStage("preferences-apply", 0);
                if (!SCPreferencesApplyChanges(prefs)) {
                    int code = SCError(); logStage("preferences-apply-failed", code);
                    return configurationFailed(@"PREFERENCES_APPLY_FAILED", code);
                }
                return YES;
            });
        }
    } else if (byID && !found) {
        // Removed service: there is no setting to restore.
        ok = operation(name, nil, ^BOOL(NSDictionary *next) { (void)next; return YES; });
    }
    } @finally {
        if (protocol) CFRelease(protocol);
        if (found) CFRelease(found);
        SCPreferencesUnlock(prefs);
        CFRelease(prefs);
    }
    return ok;
#endif
}

static BOOL restoreRecord(NSString *key) {
    NSDictionary *record = journal[key];
    NSArray *keys = keysFor(record[@"item"]);
    if (!keys || !dictionary(record[@"original"]) || !dictionary(record[@"written"])) return NO;
    BOOL ok = withService(record[@"serviceID"], YES, ^BOOL(NSString *serviceID, NSDictionary *current, BOOL (^commit)(NSDictionary *)) {
        (void)serviceID;
        if (!current) return YES;
        NSDictionary *now = subset(current, keys);
        if (![now isEqual:record[@"written"]] && ![now isEqual:record[@"original"]]) return YES; // Third party owns it now.
        return commit(merging(current, keys, record[@"original"]));
    });
    if (!ok) return NO;
    [journal removeObjectForKey:key];
    if (!savePlist(journal, path(@"journal.plist"))) { journal[key] = record; return NO; }
    return YES;
}

static BOOL recover(BOOL all) {
    BOOL ok = YES;
    for (NSString *key in [journal.allKeys copy]) {
        NSDictionary *owner = journal[key][@"owner"];
        if (all || ![processIdentity([owner[@"pid"] intValue]) isEqual:owner]) {
            if (!restoreRecord(key)) ok = NO;
        }
    }
    return ok;
}

static NSDictionary *handle(NSDictionary *request, pid_t ownerPID) {
    if (!dictionary(request) || !string(request[@"op"])) return failure(Failed);
    if ([request[@"op"] isEqual:@"status"]) return success();
    BOOL restoring = [request[@"op"] isEqual:@"restore"];
    if (!restoring && ![request[@"op"] isEqual:@"write"]) return failure(Failed);
    NSDictionary *ref = request[@"ref"];
    if (!dictionary(ref) || !string(ref[@"service"]) || [ref[@"service"] length] == 0 ||
        [ref[@"service"] length] > 1024 || !string(ref[@"item"])) return failure(Failed);
    NSArray *keys = keysFor(ref[@"item"]);
    if (!keys) return failure(Failed);
    NSDictionary *owner = processIdentity(ownerPID);
    if (!owner) return failure(Failed);
    NSDictionary *value = request[@"value"];
    if (!restoring) {
        if (!dictionary(value)) return failure(Failed);
        if (keys.count == 2) {
            // PAC capability can only disable, retaining the URL read under the lock.
            if (![value[@"enabled"] isEqual:@NO]) return failure(Failed);
        } else {
            NSNumber *port = value[@"port"];
            if (![value[@"enabled"] isEqual:@YES] || ![value[@"host"] isEqual:@"127.0.0.1"] ||
                ![port isKindOfClass:NSNumber.class] || port.doubleValue != port.intValue ||
                port.intValue < 1024 || port.intValue > 65535) return failure(Failed);
        }
    }
    __block NSString *restoreKey = nil;
    BOOL ok = withService(ref[@"service"], NO, ^BOOL(NSString *serviceID, NSDictionary *current, BOOL (^commit)(NSDictionary *)) {
        NSString *key = [serviceID stringByAppendingFormat:@"/%@", ref[@"item"]];
        if (restoring) { restoreKey = key; return YES; }
        NSDictionary *old = journal[key];
        if (old && ![old[@"owner"] isEqual:owner] &&
            [processIdentity([old[@"owner"][@"pid"] intValue]) isEqual:old[@"owner"]]) return NO;
        NSDictionary *now = subset(current, keys);
        NSMutableDictionary *written = [now mutableCopy];
        written[keys[0]] = keys.count == 2 ? @0 : @1;
        if (keys.count == 3) { written[keys[1]] = @"127.0.0.1"; written[keys[2]] = value[@"port"]; }
        // A later third-party value becomes the new recovery baseline.
        NSDictionary *original = old && [now isEqual:old[@"written"]] ? old[@"original"] : now;
        journal[key] = @{ @"serviceID": serviceID, @"item": ref[@"item"], @"original": original,
                          @"written": written, @"owner": owner };
        if (!savePlist(journal, path(@"journal.plist"))) {
            if (old) journal[key] = old; else [journal removeObjectForKey:key];
            return NO;
        }
        return commit(merging(current, keys, written));
    });
    if (ok && restoreKey && journal[restoreKey]) ok = restoreRecord(restoreKey);
    return ok ? success() : failureReason(Failed, configurationFailureReason ?: @"SYSTEM_CONFIGURATION", configurationFailureCode);
}

static int connectSocket(void) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    struct timeval timeout = { 10, 0 };
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
    int one = 1; setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
    return fd;
}
static struct sockaddr_un address(void) {
    struct sockaddr_un addr = {0}; addr.sun_family = AF_UNIX;
    strlcpy(addr.sun_path, path(@"control.sock").fileSystemRepresentation, sizeof(addr.sun_path));
    return addr;
}
static NSData *receive(int fd) {
    NSMutableData *data = [NSMutableData data];
    char buffer[4096]; ssize_t n;
    for (;;) {
        n = read(fd, buffer, sizeof(buffer));
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) break;
        [data appendBytes:buffer length:(NSUInteger)n];
        if (data.length > 16384) return nil;
    }
    return n == 0 ? data : nil;
}
static BOOL sendData(int fd, NSData *data) {
    const char *bytes = data.bytes; NSUInteger remaining = data.length;
    while (remaining) {
        ssize_t n = write(fd, bytes, remaining);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return NO;
        bytes += n; remaining -= (NSUInteger)n;
    }
    return YES;
}

static int client(BOOL status) {
    int fd = connectSocket(); struct sockaddr_un addr = address();
    NSDictionary *reply = failure(Permission);
    if (fd >= 0 && connect(fd, (struct sockaddr *)&addr, sizeof(addr)) == 0) {
        uid_t uid; gid_t gid;
        if (getpeereid(fd, &uid, &gid) == 0 &&
#ifndef LAIXIN_PROXY_FIXTURE
            uid == 0
#else
            uid == getuid()
#endif
        ) {
            NSData *input = status ? [@"{\"op\":\"status\"}" dataUsingEncoding:NSUTF8StringEncoding] : receive(STDIN_FILENO);
            if (input && sendData(fd, input)) {
                shutdown(fd, SHUT_WR);
                NSData *output = receive(fd);
                id parsed = output ? [NSJSONSerialization JSONObjectWithData:output options:0 error:nil] : nil;
                reply = dictionary(parsed) ? parsed : failureReason(Failed,
                    !output && (errno == EAGAIN || errno == EWOULDBLOCK) ? @"TIMEOUT" :
                    output.length == 0 ? @"DISCONNECTED" : @"INVALID_RESPONSE", errno);
            } else reply = failureReason(Failed, @"IO_FAILED", errno);
        }
    } else reply = failureReason(errno == ENOENT || errno == EACCES ? Permission : Failed,
        errno == ECONNREFUSED ? @"CONNECTION_REFUSED" : errno == ENOENT ? @"NOT_INSTALLED" : @"CONNECT_FAILED", errno);
    if (fd >= 0) close(fd);
    NSData *json = [NSJSONSerialization dataWithJSONObject:reply options:0 error:nil];
    return sendData(STDOUT_FILENO, json) ? 0 : 74;
}

static int serve(uid_t authorizedUID) {
    signal(SIGALRM, onDeadline);
    signal(SIGPIPE, SIG_IGN);
    logStage("starting", 2);
    int lockFD = open(path(@"daemon.lock").fileSystemRepresentation, O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
    if (lockFD < 0 || flock(lockFD, LOCK_EX | LOCK_NB) != 0) return 74;
    NSString *journalPath = path(@"journal.plist");
    if ([NSFileManager.defaultManager fileExistsAtPath:journalPath]) {
        journal = [[NSDictionary dictionaryWithContentsOfFile:journalPath] mutableCopy];
        if (!journal) return 74; // Never overwrite an unreadable recovery record.
    } else journal = [NSMutableDictionary dictionary];
    alarm(6);
    if (!recover(YES)) { logStage("startup-recovery-failed", SCError()); return 74; }
    alarm(0);
    int server = connectSocket(); struct sockaddr_un addr = address();
    listeningFD = server;
    unlink(addr.sun_path);
    if (server < 0 || bind(server, (struct sockaddr *)&addr, sizeof(addr)) != 0 ||
        chown(addr.sun_path, authorizedUID, (gid_t)-1) != 0 || chmod(addr.sun_path, 0600) != 0 || listen(server, 8) != 0) return 74;
    signal(SIGTERM, onSignal); signal(SIGINT, onSignal);
    logStage("listening", 0);
    BOOL healthy = YES;
    while (!stopping) {
        @autoreleasepool {
            alarm(6);
            @try { if (!recover(NO)) logStage("recovery-pending", SCError()); }
            @catch (NSException *exception) { (void)exception; logStage("recovery-exception", 0); healthy = NO; }
            alarm(0);
            if (!healthy) break;
            struct pollfd event = { server, POLLIN, 0 };
            int polled = poll(&event, 1, 1000);
            if ((polled < 0 && errno != EINTR) || (event.revents & (POLLERR | POLLHUP | POLLNVAL)) ||
                fcntl(server, F_GETFD) < 0) {
                logStage("listener-failed", errno); healthy = NO; break;
            }
            if (polled <= 0 || !(event.revents & POLLIN)) continue;
            int fd = accept(server, NULL, NULL);
            if (fd < 0) {
                if (errno == EINTR || errno == ECONNABORTED || errno == EAGAIN) continue;
                logStage("accept-failed", errno); healthy = NO; break;
            }
            activeFD = fd;
            struct timeval timeout = { 3, 0 };
            setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
            setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
            int one = 1; setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
            uid_t uid; gid_t gid; pid_t peerPID = 0; socklen_t size = sizeof(peerPID);
            NSDictionary *reply = failure(Permission);
            alarm(6);
            @try {
            if (getpeereid(fd, &uid, &gid) == 0 && uid == authorizedUID &&
                getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &peerPID, &size) == 0) {
                struct proc_bsdinfo peer = {0};
                if (proc_pidinfo(peerPID, PROC_PIDTBSDINFO, 0, &peer, sizeof(peer)) == sizeof(peer) && peer.pbi_uid == authorizedUID) {
                    NSData *data = receive(fd);
                    id request = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
                    logStage("request-start", 0);
                    reply = handle(request, (pid_t)peer.pbi_ppid);
                    logStage([reply[@"ok"] boolValue] ? "request-ok" : "request-failed", [reply[@"ok"] boolValue] ? 0 : SCError());
                }
            }
            } @catch (NSException *exception) {
                (void)exception;
                logStage("request-exception", 0);
                reply = failureReason(Failed, @"REQUEST_EXCEPTION", 0);
            }
            sendData(fd, [NSJSONSerialization dataWithJSONObject:reply options:0 error:nil]);
            alarm(0);
            activeFD = -1;
            close(fd);
        }
    }
    alarm(6);
    BOOL restored = recover(YES);
    alarm(0);
    close(server); unlink(addr.sun_path); close(lockFD);
    logStage("stopped", healthy && restored ? 0 : 74);
    return healthy && restored ? 0 : 74;
}

#ifndef LAIXIN_PROXY_FIXTURE
static BOOL trustedDirectory(NSString *directory) {
    struct stat st;
    return lstat(directory.fileSystemRepresentation, &st) == 0 && S_ISDIR(st.st_mode) && st.st_uid == 0 && !(st.st_mode & 0022);
}
static int launchctl(NSArray *arguments) {
    NSTask *task = [NSTask new]; task.executableURL = [NSURL fileURLWithPath:@"/bin/launchctl"];
    task.arguments = arguments; task.standardOutput = NSFileHandle.fileHandleWithNullDevice;
    task.standardError = NSFileHandle.fileHandleWithNullDevice;
    if (![task launchAndReturnError:nil]) return 74;
    [task waitUntilExit]; return task.terminationStatus;
}
static int install(uid_t uid) {
    if (geteuid() != 0 || uid < 501) return 77;
    for (NSString *directory in @[@"/Library/PrivilegedHelperTools", @"/Library/LaunchDaemons"]) {
        BOOL created = mkdir(directory.fileSystemRepresentation, 0755) == 0;
        if (!created && errno != EEXIST) return 74;
        if (!trustedDirectory(directory)) return 74;
        // Do not loosen an administrator's existing permissions on shared directories.
        if (created && chmod(directory.fileSystemRepresentation, 0755) != 0) return 74;
    }
    if (mkdir(HELPER_ROOT.fileSystemRepresentation, 0755) != 0 && errno != EEXIST) return 74;
    if (!trustedDirectory(HELPER_ROOT)) return 74;
    if (chmod(HELPER_ROOT.fileSystemRepresentation, 0755) != 0) return 74;
    NSString *plistPath = [@"/Library/LaunchDaemons" stringByAppendingPathComponent:[Label stringByAppendingString:@".plist"]];
    // Stop old helper before replacing it. Its durable journal survives any interruption.
    launchctl(@[@"bootout", [@"system/" stringByAppendingString:Label]]);
    uint32_t size = 0; _NSGetExecutablePath(NULL, &size);
    char *buffer = calloc(size, 1); if (!buffer) return 74;
    if (_NSGetExecutablePath(buffer, &size) != 0) { free(buffer); return 74; }
    NSData *binary = [NSData dataWithContentsOfFile:[NSString stringWithUTF8String:buffer]]; free(buffer);
    if (!binary || ![binary writeToFile:path(@"helper") options:NSDataWritingAtomic error:nil] ||
        chmod(path(@"helper").fileSystemRepresentation, 0755) != 0) return 74;
    if (!savePlist(@{ @"uid": @(uid) }, path(@"owner.plist"))) return 74;
    for (NSString *file in @[@"helper.log", @"helper-output.log"]) {
        int fd = open(path(file).fileSystemRepresentation, O_CREAT | O_WRONLY | O_APPEND | O_NOFOLLOW, 0600);
        struct stat st;
        BOOL valid = fd >= 0 && fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && st.st_uid == 0 && st.st_nlink == 1 && fchmod(fd, 0600) == 0;
        if (fd >= 0) close(fd);
        if (!valid) return 74;
    }
    NSDictionary *plist = @{ @"Label": Label, @"ProgramArguments": @[path(@"helper"), @"serve"],
        @"RunAtLoad": @YES, @"KeepAlive": @YES, @"ThrottleInterval": @2, @"ExitTimeOut": @20,
        @"ProcessType": @"Background", @"UserName": @"root",
        @"StandardErrorPath": path(@"helper.log"), @"StandardOutPath": path(@"helper-output.log") };
    NSData *data = [NSPropertyListSerialization dataWithPropertyList:plist format:NSPropertyListXMLFormat_v1_0 options:0 error:nil];
    if (![data writeToFile:plistPath options:NSDataWritingAtomic error:nil] || chmod(plistPath.fileSystemRepresentation, 0644) != 0) return 74;
    return launchctl(@[@"bootstrap", @"system", plistPath]);
}

// Administrative removal is deliberately not an IPC method. Recover first;
// keep the private journal as evidence rather than deleting historical state.
static int uninstall(void) {
    if (geteuid() != 0) return 77;
    if (!trustedDirectory(HELPER_ROOT) || !trustedDirectory(@"/Library/LaunchDaemons")) return 74;
    launchctl(@[@"bootout", [@"system/" stringByAppendingString:Label]]);
    int fd = open(path(@"daemon.lock").fileSystemRepresentation, O_RDWR | O_NOFOLLOW);
    if (fd < 0 || flock(fd, LOCK_EX | LOCK_NB) != 0) return 74;
    NSString *plist = [@"/Library/LaunchDaemons" stringByAppendingPathComponent:[Label stringByAppendingString:@".plist"]];
    journal = [[NSDictionary dictionaryWithContentsOfFile:path(@"journal.plist")] mutableCopy];
    if (!journal && ![NSFileManager.defaultManager fileExistsAtPath:path(@"journal.plist")]) journal = [NSMutableDictionary dictionary];
    if (!journal || !recover(YES)) {
        close(fd);
        launchctl(@[@"bootstrap", @"system", plist]);
        return 74;
    }
    BOOL removed = (unlink(plist.fileSystemRepresentation) == 0 || errno == ENOENT);
    if (removed) removed = (unlink(path(@"helper").fileSystemRepresentation) == 0 || errno == ENOENT);
    if (removed) removed = (unlink(path(@"owner.plist").fileSystemRepresentation) == 0 || errno == ENOENT);
    close(fd);
    return removed ? 0 : 74;
}
#endif

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        umask(0077);
        if (argc == 2 && strcmp(argv[1], "request") == 0) return client(NO);
        if (argc == 2 && strcmp(argv[1], "status") == 0) return client(YES);
#ifndef LAIXIN_PROXY_FIXTURE
        if (argc == 2 && strcmp(argv[1], "uninstall") == 0) return uninstall();
        if (argc == 3 && strcmp(argv[1], "install") == 0) {
            char *end; unsigned long uid = strtoul(argv[2], &end, 10);
            if (*end || uid < 501 || uid > UINT32_MAX) return 64;
            return install((uid_t)uid);
        }
        if (argc == 2 && strcmp(argv[1], "serve") == 0 && geteuid() == 0 && trustedDirectory(HELPER_ROOT)) {
            NSDictionary *owner = [NSDictionary dictionaryWithContentsOfFile:path(@"owner.plist")];
            if ([owner[@"uid"] unsignedIntValue] < 501) return 77;
            return serve([owner[@"uid"] unsignedIntValue]);
        }
#else
        if (argc == 2 && strcmp(argv[1], "serve") == 0) return serve(getuid());
#endif
        return 64;
    }
}
