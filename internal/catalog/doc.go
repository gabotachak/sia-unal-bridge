// Package catalog is the domain: course/program/section types, freshness
// policy, ports (Store, SIASource), and the read-through service. It must
// not import gin, pgx, goquery, or encoding/xml — see TestDomainHasNoInfraImports.
package catalog
