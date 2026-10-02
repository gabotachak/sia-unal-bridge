package httpapi

import (
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/time/rate"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

// rateLimiter is a per-IP token bucket. The SIA pool is the real bottleneck
// — this exists so one client can't exhaust it before anyone else gets a
// turn, not to police abuse in general. laneByIP below covers what a token
// bucket cannot see: how long each request holds a connection.
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

// foregroundPerIP is how many requests one IP may have in flight before the
// rest of its requests go to the pool's background lane. A person never has
// more than a few pages loading at once; the web's bulk seat measurement
// already says ?background=1.
const foregroundPerIP = 4

// laneByIP keeps one client from holding every SIA connection. The token
// bucket above counts requests, not how long each one holds a connection: a
// cache hit and a 10 s SIA miss cost the same token. So a client asking for
// many distinct cold courses could fill the pool and leave everyone else
// with 503 busy.
//
// It demotes instead of rejecting: past the cap a request still runs, but in
// the background lane, which sia.Pool caps at half the pool. A whole campus
// behind one NAT address still gets served; it just cannot take the other
// half from everyone else.
func laneByIP() gin.HandlerFunc {
	var mu sync.Mutex
	inFlight := make(map[string]int)
	return func(c *gin.Context) {
		if c.Query("background") == "1" {
			c.Request = c.Request.WithContext(catalog.WithBackground(c.Request.Context()))
			c.Next()
			return
		}
		ip := c.ClientIP()
		mu.Lock()
		inFlight[ip]++
		over := inFlight[ip] > foregroundPerIP
		mu.Unlock()
		defer func() {
			mu.Lock()
			if inFlight[ip]--; inFlight[ip] == 0 {
				delete(inFlight, ip)
			}
			mu.Unlock()
		}()
		if over {
			c.Request = c.Request.WithContext(catalog.WithBackground(c.Request.Context()))
		}
		c.Next()
	}
}
