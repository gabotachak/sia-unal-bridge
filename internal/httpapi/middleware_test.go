package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
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
