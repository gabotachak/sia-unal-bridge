package httpapi

import (
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/time/rate"
)

// rateLimiter is a per-IP token bucket. The SIA pool is the real bottleneck
// (docs/OPEN-QUESTIONS.md §5: 8 concurrent sessions measured clean, never
// more) — this exists so one client can't exhaust it before anyone else gets
// a turn, not to police abuse in general.
type rateLimiter struct {
	mu       sync.Mutex
	visitors map[string]*visitor
	r        rate.Limit
	burst    int
}

type visitor struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

// newRateLimiter builds a limiter allowing r requests/sec per IP with burst
// as the bucket size. staleAfter-old entries are swept so long-running
// processes don't accumulate one bucket per IP forever.
func newRateLimiter(r rate.Limit, burst int) *rateLimiter {
	rl := &rateLimiter{visitors: make(map[string]*visitor), r: r, burst: burst}
	go rl.sweep()
	return rl
}

const (
	staleAfter  = 10 * time.Minute
	sweepPeriod = time.Minute
)

func (rl *rateLimiter) sweep() {
	for range time.Tick(sweepPeriod) {
		rl.mu.Lock()
		for ip, v := range rl.visitors {
			if time.Since(v.lastSeen) > staleAfter {
				delete(rl.visitors, ip)
			}
		}
		rl.mu.Unlock()
	}
}

func (rl *rateLimiter) allow(ip string) bool {
	rl.mu.Lock()
	v, ok := rl.visitors[ip]
	if !ok {
		v = &visitor{limiter: rate.NewLimiter(rl.r, rl.burst)}
		rl.visitors[ip] = v
	}
	v.lastSeen = time.Now()
	allowed := v.limiter.Allow()
	rl.mu.Unlock()
	return allowed
}

// middleware keys on c.ClientIP(), which gin derives from RemoteAddr unless
// trusted proxies are configured — see NewRouter's SetTrustedProxies. Behind
// an untrusted/misconfigured proxy this would key on the proxy's own IP and
// throttle everyone as one client; that's a config bug to catch separately,
// not something this middleware can detect.
func (rl *rateLimiter) middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !rl.allow(c.ClientIP()) {
			c.Header("Retry-After", "1")
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
				"error":   "rate_limit",
				"message": "too many requests",
			})
			return
		}
		c.Next()
	}
}
