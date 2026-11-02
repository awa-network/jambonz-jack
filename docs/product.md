# JACK

JACK is the **Jambonz Application Compatibility Kit**.

Run TwiML and LaML voice applications on jambonz.

Repo, package, and container name: `jambonz-jack`.

## Overview

JACK is a compatibility layer for running supported Twilio and SignalWire voice flows on jambonz. Compatibility is partial; applications using unsupported verbs, status callbacks, or provider-specific semantics need adaptation and live-call validation.

Rather than requiring a complete rewrite from TwiML/LaML XML to native jambonz JSON, JACK translates application requests and responses between the two ecosystems.

The goal is to simplify migration from proprietary CPaaS platforms to open, self-hosted jambonz infrastructure while preserving existing application logic and webhook integrations.

The name works in two directions: JACK stands for Jambonz Application Compatibility Kit, and it also evokes the telephony idea of a jack that plugs systems together.

## Components

### JACK Bridge

The JACK Bridge converts TwiML and LaML XML instructions into jambonz application JSON.

Examples include:

- `<Say>` -> jambonz speech actions
- `<Play>` -> jambonz playback actions
- `<Gather>` -> jambonz input collection
- `<Dial>` -> jambonz call control
- Additional TwiML and LaML verbs as supported

This allows existing Twilio or SignalWire applications to execute on jambonz without requiring native jambonz application logic.

### JACK Status (planned)

JACK Status is a planned component for routing jambonz events and call state changes into Twilio-compatible status webhooks. It is not implemented as a separate router or endpoint. The existing bridge forwards selected call parameters when requesting XML from upstream applications.

Planned event coverage includes:

- Call status updates
- Answered events
- Completed events
- Failed events
- DTMF and gather results
- Other supported callback payloads

The aim is to preserve existing webhook handlers where the provider event contracts can be reproduced.

## Architecture

```text
Twilio / SignalWire Application
        |
        v
    JACK Bridge
        |
        v
      jambonz
        |
        v
    JACK Status (planned)
        |
        v
Twilio-Compatible Webhooks
```

## Goals

- Reduce migration effort from Twilio and SignalWire to jambonz
- Preserve existing application logic
- Preserve existing webhook integrations
- Minimize code changes
- Provide a familiar execution model for TwiML and LaML applications
- Accelerate adoption of open and self-hosted voice infrastructure

## Future Extensions

JACK is designed as a modular compatibility framework.

Potential future components include:

- JACK Media Streams
- JACK SIP Adapter
- JACK SMS Adapter
- JACK Recorder
- JACK Test Suite
- Additional protocol and API compatibility modules

## Positioning

JACK is not a TwiML editor, proxy, or migration tool.

JACK is an application compatibility layer for jambonz.

It allows organizations to continue running existing Twilio and SignalWire workloads while adopting jambonz as the underlying execution platform.
