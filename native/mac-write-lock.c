// macOS 12+ replacement for the non-universal system lockf utility.
// exec (not fork) keeps the flock in the transition process: killing it releases
// the lock, and can never leave an unlocked transition child running behind it.
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <limits.h>
#include <locale.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

// Read-only identity lookup avoids executing the setuid /bin/ps. Keep its C
// locale lstart format exactly: existing live owners must never look stale.
static int process_start(const char *text) {
    if (text[0] == '\0' || strspn(text, "0123456789") != strlen(text)) return 64;
    errno = 0;
    long parsed = strtol(text, NULL, 10);
    if (errno != 0 || parsed <= 0 || parsed > INT_MAX) return 64;
    struct proc_bsdinfo info = {0};
    int count = proc_pidinfo((pid_t)parsed, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
    if (count != sizeof(info) || info.pbi_pid != (uint32_t)parsed
        || info.pbi_uid != getuid() || info.pbi_start_tvsec == 0) return 74;
    time_t started = (time_t)info.pbi_start_tvsec;
    struct tm local;
    char identity[64];
    if (setlocale(LC_TIME, "C") == NULL || localtime_r(&started, &local) == NULL
        || strftime(identity, sizeof(identity), "%a %b %e %H:%M:%S %Y", &local) == 0) return 74;
    return puts(identity) == EOF ? 74 : 0;
}

static double monotonic_seconds(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1;
    return (double)now.tv_sec + (double)now.tv_nsec / 1000000000.0;
}

int main(int argc, char **argv) {
    if (argc == 3 && strcmp(argv[1], "--process-start") == 0) return process_start(argv[2]);
    if (argc < 4 || (strcmp(argv[1], "0") != 0 && strcmp(argv[1], "1") != 0)
        || argv[2][0] != '/' || argv[3][0] != '/') return 64;
    // JS creates the stable private file first. Never create, follow a symlink,
    // truncate, or unlink it here. Do not set CLOEXEC: Node must retain this fd.
    int fd = open(argv[2], O_RDWR | O_NOFOLLOW | O_NONBLOCK);
    struct stat held, named;
    if (fd < 0 || fstat(fd, &held) != 0 || !S_ISREG(held.st_mode)
        || held.st_uid != getuid() || (held.st_mode & 077) != 0
        || held.st_nlink != 1) return 74;
    double started = monotonic_seconds();
    if (started < 0) return 74;
    double deadline = started + (argv[1][0] == '1' ? 1.0 : 0.0);
    while (flock(fd, LOCK_EX | LOCK_NB) != 0) {
        if (errno != EWOULDBLOCK && errno != EINTR) return 74;
        double now = monotonic_seconds();
        if (now < 0) return 74;
        if (now >= deadline) return 75;
        struct timespec pause = { .tv_sec = 0, .tv_nsec = 10000000 };
        nanosleep(&pause, NULL);
    }
    if (lstat(argv[2], &named) != 0 || !S_ISREG(named.st_mode)
        || named.st_dev != held.st_dev || named.st_ino != held.st_ino
        || named.st_uid != getuid() || (named.st_mode & 077) != 0
        || named.st_nlink != 1) return 74;
    execv(argv[3], &argv[3]);
    return 74;
}
