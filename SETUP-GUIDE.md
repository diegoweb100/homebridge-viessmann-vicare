# Guida Configurazione Completa

## Prerequisiti

### 1. Account ViCare
- Crea un account su [ViCare](https://www.vicare.it/)
- Registra la tua caldaia Viessmann nell'app ViCare
- Verifica che la caldaia sia online e funzionante

### 2. Credenziali API Viessmann
Per ottenere le credenziali API:

1. **Vai al Developer Portal**:
   - Visita https://developer.viessmann.com/
   - Registra un account sviluppatore

2. **Crea un'applicazione**:
   - Nome: `homebridge-viessmann-vicare`
   - Tipo: `Public Client` (per uso domestico)
   - Redirect URI: `http://localhost:4200/`
   - Scope: `IoT User offline_access`

3. **Ottieni il Client ID**:
   - Salva il Client ID generato
   - Il Client Secret non è necessario per client pubblici

## Installazione Step-by-Step

### 1. Installa il plugin

```bash
# Via Homebridge Config UI X (raccomandato)
# Cerca "homebridge-viessmann-vicare" nella scheda Plugin

# Oppure via npm
sudo npm install -g homebridge-viessmann-vicare
```

### 2. Configura il plugin

Aggiungi la configurazione al file `config.json` di Homebridge:

```json
{
    "platform": "ViessmannPlatform",
    "name": "Viessmann",
    "clientId": "IL_TUO_CLIENT_ID",
    "username": "tua-email@example.com",
    "password": "la-tua-password",
    "refreshInterval": 60000,
    "debug": true
}
```

### 3. Prima configurazione OAuth

⚠️ **Importante**: Il primo setup richiede una configurazione OAuth manuale.

1. **Genera codici PKCE**:
   Usa questo tool online: https://tonyxu-io.github.io/pkce-generator/
   - Salva il `Code Verifier` e `Code Challenge`

2. **Ottieni Authorization Code**:
   ```
   https://iam.viessmann.com/idp/v3/authorize?
   client_id=IL_TUO_CLIENT_ID&
   redirect_uri=http://localhost:4200/&
   scope=IoT%20User%20offline_access&
   response_type=code&
   code_challenge_method=S256&
   code_challenge=IL_TUO_CODE_CHALLENGE
   ```

3. **Accedi e autorizza**:
   - Apri il link nel browser
   - Accedi con le credenziali ViCare
   - Autorizza l'applicazione
   - Copia il `code` dall'URL di reindirizzamento

4. **Scambia il code per i token**:
   ```bash
   curl -X POST "https://iam.viessmann.com/idp/v3/token" \
   -H "Content-Type: application/x-www-form-urlencoded" \
   -d "client_id=IL_TUO_CLIENT_ID&redirect_uri=http://localhost:4200/&grant_type=authorization_code&code_verifier=IL_TUO_CODE_VERIFIER&code=IL_CODICE_OTTENUTO"
   ```

5. **Salva i token**:
   Il plugin gestirà automaticamente il refresh dei token dopo la prima configurazione.

### 4. Riavvia Homebridge

```bash
# Se usi systemd
sudo systemctl restart homebridge

# Se usi pm2
pm2 restart homebridge

# Se usi Docker
docker restart homebridge
```

## Configurazione Avanzata

### Parametri opzionali

```json
{
    "platform": "ViessmannPlatform",
    "name": "Viessmann",
    "clientId": "client_id",
    "username": "email",
    "password": "password",
    
    // Intervallo aggiornamento (30-300 secondi)
    "refreshInterval": 60000,
    
    // Debug logging
    "debug": true
}
```

### Personalizzazione accessori

Il plugin crea automaticamente gli accessori basandosi sui dispositivi rilevati:

- **Caldaia**: Controllo temperatura e modalità operative
- **DHW**: Controllo acqua calda sanitaria
- **Circuiti**: Un termostato per ogni circuito di riscaldamento

## Verifica Configurazione

### 1. Controlla i log
```bash
# Homebridge standard
tail -f ~/.homebridge/homebridge.log

# Systemd
journalctl -u homebridge -f

# Docker
docker logs -f homebridge
```

### 2. Test API
```bash
# Test connessione installazioni
curl -H "Authorization: Bearer TOKEN" \
"https://api.viessmann.com/iot/v2/equipment/installations"
```

### 3. Verifica HomeKit
- Apri l'app Casa su iOS/macOS
- Controlla che gli accessori Viessmann siano visibili
- Testa i comandi di temperatura

## Risoluzione Problemi Comuni

### Errore: "Authentication failed"
- Verifica credenziali ViCare
- Controlla che il dispositivo sia registrato
- Ricontrolla Client ID

### Errore: "No installations found"
- Verifica che la caldaia sia online in ViCare
- Controlla che l'account abbia accesso ai dispositivi
- Abilita debug logging

### Comandi non funzionano
- Alcuni dispositivi hanno limitazioni sui comandi
- Verifica le modalità operative supportate
- Controlla i log per errori specifici

### Rate limiting
- Riduci la frequenza di aggiornamento (`refreshInterval`)
- L'API ha limiti di 1200 richieste/ora per utente

## Struttura Plugin

```
homebridge-viessmann-vicare/
├── src/
│   ├── platform.ts              # Piattaforma principale
│   ├── viessmann-api.ts          # Client API Viessmann
│   ├── accessories/
│   │   ├── boiler-accessory.ts   # Accessorio caldaia
│   │   ├── dhw-accessory.ts      # Accessorio DHW
│   │   └── heating-circuit-accessory.ts # Circuiti riscaldamento
│   ├── index.ts                  # Entry point
│   └── settings.ts               # Costanti
├── config.schema.json            # Schema configurazione
├── package.json
└── README.md
```

## Supporto

Per problemi specifici:

1. **Abilita debug logging**
2. **Raccogli i log completi**
3. **Crea issue su GitHub** con:
   - Configurazione (senza password)
   - Log completi
   - Modello caldaia
   - Versione plugin

## Aggiornamenti

Il plugin supporta aggiornamenti automatici:

```bash
# Controlla aggiornamenti
npm outdated -g homebridge-viessmann-vicare

# Aggiorna
npm update -g homebridge-viessmann-vicare
```

Dopo gli aggiornamenti, riavvia sempre Homebridge.