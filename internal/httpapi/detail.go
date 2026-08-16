package httpapi

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/gabotachak/sia-unal-bridge/internal/catalog"
)

func (a *api) courseDetail(c *gin.Context) {
	program, err := a.resolveProgram(c)
	if err != nil {
		return
	}
	code := c.Param("code")
	maxAge, ok := parseMaxAge(c)
	if !ok {
		badRequest(c, "invalid max_age")
		return
	}

	if a.refreshBlocked(c, program, code, maxAge) {
		return
	}

	offering, res, err := a.svc.CourseDetail(c.Request.Context(), program, code, maxAge)
	if err != nil {
		writeError(c, err, "unknown_course")
		return
	}

	now := time.Now()
	setFreshnessHeaders(c, res, courseAge(offering, now), resolveMaxAge(maxAge, catalog.FreshnessDetail))
	c.JSON(http.StatusOK, courseDetailJSON(offering, now))
}

// courseSections and courseDetail share one fetch: sections are never
// cheaper to get on their own (the detail POST always brings the whole
// group list — docs/ARCH.md).
func (a *api) courseSections(c *gin.Context) {
	program, err := a.resolveProgram(c)
	if err != nil {
		return
	}
	code := c.Param("code")
	maxAge, ok := parseMaxAge(c)
	if !ok {
		badRequest(c, "invalid max_age")
		return
	}

	if a.refreshBlocked(c, program, code, maxAge) {
		return
	}

	offering, res, err := a.svc.CourseDetail(c.Request.Context(), program, code, maxAge)
	if err != nil {
		writeError(c, err, "unknown_course")
		return
	}

	now := time.Now()
	setFreshnessHeaders(c, res, courseAge(offering, now), resolveMaxAge(maxAge, catalog.FreshnessDetail))
	sections := make([]gin.H, len(offering.Course.Sections))
	for i, s := range offering.Course.Sections {
		sections[i] = sectionJSON(s, now)
	}
	c.JSON(http.StatusOK, gin.H{"sections": sections})
}

func (a *api) courseSection(c *gin.Context) {
	program, err := a.resolveProgram(c)
	if err != nil {
		return
	}
	code, key := c.Param("code"), c.Param("key")
	maxAge, ok := parseMaxAge(c)
	if !ok {
		badRequest(c, "invalid max_age")
		return
	}

	if a.refreshBlocked(c, program, code, maxAge) {
		return
	}

	offering, res, err := a.svc.CourseDetail(c.Request.Context(), program, code, maxAge)
	if err != nil {
		writeError(c, err, "unknown_course")
		return
	}
	section, found := findSection(offering.Course.Sections, key)
	if !found {
		c.JSON(http.StatusNotFound, gin.H{"error": "unknown_section", "message": "no such section key for this course"})
		return
	}

	now := time.Now()
	age := section.FetchedAt
	if section.Seats != nil && section.Seats.MeasuredAt.Before(age) {
		age = section.Seats.MeasuredAt
	}
	setFreshnessHeaders(c, res, now.Sub(age), resolveMaxAge(maxAge, catalog.FreshnessDetail))
	c.JSON(http.StatusOK, sectionJSON(section, now))
}

// sectionSeats echoes docs/API.md's "nunca se sirve un cupo sin decir de
// cuándo es": age_seconds always rides in the body, not just headers.
func (a *api) sectionSeats(c *gin.Context) {
	program, err := a.resolveProgram(c)
	if err != nil {
		return
	}
	code, key := c.Param("code"), c.Param("key")
	maxAge, ok := parseMaxAge(c)
	if !ok {
		badRequest(c, "invalid max_age")
		return
	}

	if a.refreshBlocked(c, program, code, maxAge) {
		return
	}

	section, res, err := a.svc.SectionSeats(c.Request.Context(), program, code, key, maxAge)
	if err != nil {
		writeError(c, err, "unknown_section")
		return
	}
	if section.Seats == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "unknown_section", "message": "no such section key, or no seat data yet"})
		return
	}

	now := time.Now()
	setFreshnessHeaders(c, res, now.Sub(section.Seats.MeasuredAt), resolveMaxAge(maxAge, catalog.FreshnessSeats))
	c.JSON(http.StatusOK, gin.H{
		"key": section.Key, "number": section.Number,
		"available": section.Seats.Available, "measured_at": section.Seats.MeasuredAt,
		"age_seconds": int(now.Sub(section.Seats.MeasuredAt).Seconds()),
	})
}

func findSection(sections []catalog.Section, key string) (catalog.Section, bool) {
	for _, s := range sections {
		if s.Key == key {
			return s, true
		}
	}
	return catalog.Section{}, false
}

func courseDetailJSON(o catalog.CourseOffering, now time.Time) gin.H {
	sections := make([]gin.H, len(o.Course.Sections))
	for i, s := range o.Course.Sections {
		sections[i] = sectionJSON(s, now)
	}
	return gin.H{
		"campus_code": o.Course.CampusCode, "code": o.Course.Code, "name": o.Course.Name,
		"credits": o.Course.Credits, "typology": o.Typology, "description": o.Course.Description,
		"fetched_at": o.Course.FetchedAt, "sections": sections,
	}
}

func sectionJSON(s catalog.Section, now time.Time) gin.H {
	h := gin.H{
		"term": s.Term, "key": s.Key, "number": s.Number,
		"label": s.Label, "instructor": s.Instructor, "shift": s.Shift, "duration": s.Duration,
		"fetched_at": s.FetchedAt,
	}
	if s.Site != "" {
		h["site"] = s.Site
	}
	if s.SiteCampus != "" {
		h["site_campus"] = s.SiteCampus
	}
	if s.StartDate != nil {
		h["start_date"] = s.StartDate.Format("2006-01-02")
	}
	if s.EndDate != nil {
		h["end_date"] = s.EndDate.Format("2006-01-02")
	}
	schedule := make([]gin.H, len(s.Schedule))
	for i, cs := range s.Schedule {
		schedule[i] = gin.H{
			"weekday": isoWeekday(cs.Weekday), "start_time": cs.StartTime, "end_time": cs.EndTime,
			"room": cs.Room, "building": cs.Building,
		}
	}
	h["schedule"] = schedule
	if s.Seats != nil {
		h["seats"] = gin.H{
			"available": s.Seats.Available, "measured_at": s.Seats.MeasuredAt,
			"age_seconds": int(now.Sub(s.Seats.MeasuredAt).Seconds()),
		}
	}
	return h
}

// isoWeekday: docs/API.md "weekday: 1 = lunes … 7 = domingo" — Go's
// time.Weekday has Sunday=0, so it needs the same +7 fixup store.go applies
// on the write path. Small, deliberate duplication across the driven/driving
// adapter boundary rather than a shared helper neither owns.
func isoWeekday(wd time.Weekday) int {
	if wd == time.Sunday {
		return 7
	}
	return int(wd)
}
