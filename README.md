# homebridge-viessmann-vicare

[![npm](https://img.shields.io/npm/v/homebridge-viessmann-vicare.svg)](https://www.npmjs.com/package/homebridge-viessmann-vicare)
[![GitHub release](https://img.shields.io/github/release/diegoweb100/homebridge-viessmann-vicare.svg)](https://github.com/diegoweb100/homebridge-viessmann-vicare/releases)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-viessmann-vicare.svg)](https://www.npmjs.com/package/homebridge-viessmann-vicare)
[![GitHub stars](https://img.shields.io/github/stars/diegoweb100/homebridge-viessmann-vicare.svg)](https://github.com/diegoweb100/homebridge-viessmann-vicare/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/diegoweb100/homebridge-viessmann-vicare.svg)](https://github.com/diegoweb100/homebridge-viessmann-vicare/issues)

Un plugin Homebridge completo per i sistemi di riscaldamento Viessmann che supporta il **controllo totale** di caldaie, acqua calda sanitaria (DHW) e circuiti di riscaldamento attraverso Apple HomeKit.

## 🚀 Caratteristiche principali

- **🔥 Controllo completo della caldaia**: Temperatura, modalità operative, stato bruciatori
- **🚿 Gestione acqua calda sanitaria (DHW)**: Controllo temperatura e modalità di funzionamento  
- **🏠 Circuiti di riscaldamento**: Controllo individuale di ogni circuito con temperatura e modalità
- **↔️ Comandi bidirezionali**: Lettura **E** scrittura di tutti i parametri supportati
- **🔐 Autenticazione sicura**: OAuth2 con refresh automatico dei token
- **⚡ Aggiornamenti in tempo reale**: Monitoraggio continuo dello stato dei dispositivi
- **🎛️ Configurazione semplice**: Supporto completo per Homebridge Config UI X
- **🎯 Integrazione nativa**: Compatibilità totale con l'app Casa e controlli Siri

## 🏠 Dispositivi supportati

Tutti i sistemi di riscaldamento Viessmann compatibili con l'API ViCare:

- **Caldaie a gas e gasolio**
- **Pompe di calore** (air-to-water, ground-source)
- **Sistemi ibridi** (caldaia + pompa di calore)
- **Caldaie a pellet e biomassa**
- **Sistemi combinati** riscaldamento/raffrescamento
- **Sistemi solari termici**
- **Sistemi di ventilazione**

## 📦 Installazione

### Tramite Homebridge Config UI X (Raccomandato)

1. Cerca "**homebridge-viessmann-vicare**" nella scheda Plugin
2. Clicca "**Installa**"
3. Configura il plugin tramite l'interfaccia web

### Tramite npm

```bash
npm install -g homebridge-viessmann-vicare
```

## 🔧 Configurazione

### Prerequisiti

1. **Account ViCare**: Account Viessmann ViCare attivo
2. **API Credentials**: Client ID dal Viessmann Developer Portal
3. **Sistema registrato**: Caldaia/sistema registrato in ViCare

### Ottenere le credenziali API

1. Visita il [**Viessmann Developer Portal**](https://developer.viessmann.com/)
2. Registra un account sviluppatore
3. **Crea una nuova applicazione**:
   - Nome: `homebridge-viessmann-vicare`
   - Tipo: **Public Client**
   - Redirect URI: `http://localhost:4200/`
   - Scope: `IoT User offline_access`
4. Salva il **Client ID** generato

### Esempio configurazione

```json
{
    "platform": "ViessmannPlatform",
    "name": "Viessmann",
    "clientId": "il_tuo_client_id_qui",
    "username": "il_tuo_email@example.com",
    "password": "la_tua_password_vicare",
    "refreshInterval": 60000,
    "debug": false
}
```

### Parametri di configurazione

| Parametro | Tipo | Richiesto | Descrizione |
|-----------|------|-----------|-------------|
| `platform` | string | ✅ | Deve essere "**ViessmannPlatform**" |
| `name` | string | ✅ | Nome della piattaforma in HomeKit |
| `clientId` | string | ✅ | Client ID dall'API Viessmann |
| `username` | string | ✅ | Email del tuo account ViCare |
| `password` | string | ✅ | Password del tuo account ViCare |
| `refreshInterval` | number | ❌ | Intervallo aggiornamento in ms (default: 60000) |
| `debug` | boolean | ❌ | Abilita logging dettagliato (default: false) |

## 🏠 Accessori HomeKit creati

Il plugin crea automaticamente questi accessori:

### 🔥 Caldaia
- **Nome**: `[Installazione] Boiler`
- **Tipo**: Termostato
- **Controlli**: Temperatura target, modalità operative (Off/Heat/Auto)
- **Sensori**: Temperatura corrente, stato riscaldamento

### 🚿 Acqua Calda Sanitaria
- **Nome**: `[Installazione] Hot Water`
- **Tipo**: Termostato
- **Controlli**: Temperatura DHW (35-65°C), modalità On/Off
- **Sensori**: Temperatura corrente, stato caricamento

### 🏠 Circuiti di Riscaldamento
- **Nome**: `[Installazione] Heating Circuit X`
- **Tipo**: Termostato (uno per ogni circuito)
- **Controlli**: Temperatura comfort, modalità operative
- **Sensori**: Temperatura ambiente, umidità (se disponibile)

## 🎯 Funzionalità avanzate

### Modalità operative supportate

**Caldaia:**
- `Off` → Standby
- `Heat` → Solo riscaldamento
- `Auto` → Riscaldamento + DHW

**DHW:**
- `Off` → Spento
- `Heat` → Modalità bilanciata

**Circuiti:**
- `Off` → Standby
- `Heat` → Solo riscaldamento
- `Auto` → Riscaldamento + DHW

### Caratteristiche supportate

Il plugin utilizza queste **feature API Viessmann**:

**Caldaia e Bruciatori:**
- `heating.boiler.sensors.temperature.main`
- `heating.boiler.temperature`
- `heating.burners.0` (stato bruciatore)
- `heating.burners.0.modulation`

**Acqua Calda Sanitaria:**
- `heating.dhw.temperature.main`
- `heating.dhw.sensors.temperature.hotWaterStorage`
- `heating.dhw.charging`
- `heating.dhw.operating.modes.active`

**Circuiti di Riscaldamento:**
- `heating.circuits.N.sensors.temperature.room`
- `heating.circuits.N.sensors.temperature.supply`
- `heating.circuits.N.operating.modes.active`
- `heating.circuits.N.operating.programs.comfort`
- `heating.circuits.N.circulation.pump`

## 🔧 Risoluzione problemi

### Problemi di autenticazione

1. ✅ Verifica che le credenziali ViCare siano corrette
2. ✅ Controlla che il Client ID sia valido
3. ✅ Assicurati che il dispositivo sia registrato in ViCare
4. ✅ Abilita debug logging per maggiori dettagli

### Dispositivi non trovati

1. ✅ Verifica che la caldaia sia online in ViCare
2. ✅ Controlla che l'installazione abbia gateway attivi
3. ✅ Assicurati che i dispositivi abbiano le caratteristiche supportate

### Comandi non funzionanti

1. ✅ Verifica che il dispositivo supporti i comandi specifici
2. ✅ Controlla i permessi dell'API
3. ✅ Alcuni dispositivi richiedono modalità specifiche

### Debug logging

Abilita il debug logging:

```json
{
    "platform": "ViessmannPlatform",
    "debug": true,
    // ... altre configurazioni
}
```

## 🔧 API Viessmann utilizzate

- **IoT Equipment API v1/v2**: Gestione installazioni, gateway e dispositivi
- **IoT Features API v2**: Controllo caratteristiche e comandi
- **IAM Authentication v3**: Autenticazione OAuth2 con PKCE

## ⚠️ Limitazioni note

1. **Setup iniziale**: Richiede configurazione OAuth manuale per il primo accesso
2. **Rate limiting**: L'API Viessmann limita le richieste (1200/ora per utente)
3. **Caratteristiche dispositivo**: Non tutti i dispositivi supportano tutte le funzionalità
4. **Latenza comandi**: I comandi possono richiedere alcuni secondi

## 🤝 Contribuire

I contributi sono benvenuti! Per favore:

1. Fai un fork del repository
2. Crea un branch per la tua feature
3. Testa le modifiche
4. Invia una pull request

## 📋 Compatibilità

- **Homebridge**: >= 1.8.0 o >= 2.0.0-beta.0
- **Node.js**: >= 18.15.0
- **API Viessmann**: v1 e v2
- **iOS**: Tutti i dispositivi supportati da HomeKit

## 📄 Licenza

Questo progetto è sotto licenza MIT - vedi il file [LICENSE](LICENSE) per dettagli.

## 🙏 Ringraziamenti

- Basato sulla struttura del plugin [homebridge-melcloud-control](https://github.com/grzegorz914/homebridge-melcloud-control)
- Documentazione API Viessmann disponibile su [Viessmann Developer Portal](https://developer.viessmann.com/)

## 📞 Supporto

Per problemi e domande:

1. Controlla la sezione [🔧 Risoluzione problemi](#🔧-risoluzione-problemi)
2. Cerca tra le [Issues esistenti](https://github.com/diegoweb100/homebridge-viessmann-vicare/issues)
3. Crea una nuova issue con dettagli completi e log di debug

---

**Nota**: Questo plugin non è ufficialmente affiliato con Viessmann. È un progetto open source della comunità.