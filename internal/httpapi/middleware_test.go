package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

func TestRequestTimeout_ZeroDisablesIt(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(requestTimeout(0))
	r.GET("/", func(c *gin.Context) {
		if _, ok := c.Request.Context().Deadline(); ok {
			t.Error("requestTimeout(0) set a deadline, want none")
		}
		c.Status(http.StatusOK)
	})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
}

func TestRequestTimeout_BoundsAWaitOnAPoolLikeChannel(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(requestTimeout(20 * time.Millisecond))
	r.GET("/", func(c *gin.Context) {
		select {
		case <-c.Request.Context().Done():
			c.Status(http.StatusServiceUnavailable)
		case <-time.After(time.Second): // stands in for an Acquire() that never gets a connection
			c.Status(http.StatusOK)
		}
	})
	w := httptest.NewRecorder()
	start := time.Now()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/", nil))
	elapsed := time.Since(start)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", w.Code)
	}
	if elapsed > 200*time.Millisecond {
		t.Fatalf("took %s, want bounded near the 20ms timeout, not the 1s handler wait", elapsed)
	}
}

func TestLaneByIP_DemotesPastTheCapAndForgetsTheIP(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h := laneByIP()
	release := make(chan struct{})
	lanes := make(chan bool, foregroundPerIP+2)
	r.GET("/", h, func(c *gin.Context) {
		lanes <- catalog.IsBackground(c.Request.Context())
		<-release
	})

	done := make(chan struct{})
	for range foregroundPerIP + 1 {
		go func() {
			r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
			done <- struct{}{}
		}()
	}
	background := 0
	for range foregroundPerIP + 1 {
		if <-lanes {
			background++
		}
	}
	if background != 1 {
		t.Fatalf("background = %d of %d, want exactly 1 past the cap", background, foregroundPerIP+1)
	}
	close(release)
	for range foregroundPerIP + 1 {
		<-done
	}

	// Everything finished: the next request starts from zero, in the foreground.
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
	if <-lanes {
		t.Fatal("IP still counted after its requests finished")
	}
	// ?background=1 always goes to the background lane.
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/?background=1", nil))
	if !<-lanes {
		t.Fatal("?background=1 not in the background lane")
	}
}
