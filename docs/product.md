# JACK

JACK is the **Jambonz Application Compatibility Kit**.

Run TwiML and LaML voice applications on jambonz.

Repo, package, and container name: `jambonz-jack`.

## Overview

JACK is a compatibility layer that enables existing Twilio and SignalWire voice applications to run on jambonz with minimal or no application changes.

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

### JACK Status

JACK Status routes and translates jambonz events and call state changes into Twilio-compatible webhook callbacks.

Examples include:

- Call status updates
- Answered events
- Completed events
- Failed events
- DTMF and gather results
- Other supported callback payloads

This enables existing webhook handlers and application backends to continue operating without modification.

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
    JACK Status
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
