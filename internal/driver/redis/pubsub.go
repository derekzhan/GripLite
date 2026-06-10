package redis

import (
	"context"
)

// Subscription is a live pub/sub subscription. Messages streams decoded
// messages until Close is called or the context is cancelled.
type Subscription struct {
	pubsub  interface{ Close() error }
	Stop    func() error
	Messages <-chan PubSubMessage
}

// Subscribe subscribes to one or more channels (exact names; use PSubscribe-
// style patterns by passing channels containing glob characters via patterns).
// It returns a Subscription whose Messages channel is closed when Stop runs.
func (d *Driver) Subscribe(ctx context.Context, channels []string, patterns []string) (*Subscription, error) {
	c, err := d.clientForDB(d.base.DB)
	if err != nil {
		return nil, err
	}
	subCtx, cancel := context.WithCancel(ctx)
	ps := c.Subscribe(subCtx)
	if len(channels) > 0 {
		if err := ps.Subscribe(subCtx, channels...); err != nil {
			cancel()
			_ = ps.Close()
			return nil, err
		}
	}
	if len(patterns) > 0 {
		if err := ps.PSubscribe(subCtx, patterns...); err != nil {
			cancel()
			_ = ps.Close()
			return nil, err
		}
	}
	out := make(chan PubSubMessage, 64)
	go func() {
		defer close(out)
		ch := ps.Channel()
		for {
			select {
			case <-subCtx.Done():
				return
			case msg, ok := <-ch:
				if !ok {
					return
				}
				select {
				case out <- PubSubMessage{Channel: msg.Channel, Pattern: msg.Pattern, Payload: msg.Payload}:
				case <-subCtx.Done():
					return
				}
			}
		}
	}()
	return &Subscription{
		pubsub:   ps,
		Messages: out,
		Stop: func() error {
			cancel()
			return ps.Close()
		},
	}, nil
}
