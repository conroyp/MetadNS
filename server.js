require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const dns2 = require('dns2');

const { Packet } = dns2;

class StripeDnsServer {
  constructor(options = {}) {
    this.stripeClient = options.stripeClient || stripe;
    this.port = options.port || 5333;
    this.address = options.address || '0.0.0.0';
    this.server = this._createServer();
  }

  _createServer() {
    return dns2.createServer({
      udp: true,
      handle: this._handleRequest.bind(this)
    });
  }

  async _handleRequest(request, send) {
    const response = Packet.createResponseFromRequest(request);
    const [question] = request.questions;
    const { name, type } = question;

    try {
      // Get domain parts
      const { topDomain, subdomain } = this.parseDomainParts(name);

      // Look up records
      const recordSet = await this.lookupDnsRecords(topDomain, subdomain);

      // Add records to response if found
      if (recordSet) {
        this.addRecordsToResponse(response, name, recordSet, type);
      } else {
        console.log('No matching records found');
      }
    } catch (error) {
      console.error('Error processing request:', error);
      // If error, return a fallback response
      response.answers.push({
        name,
        type: Packet.TYPE.A,
        class: Packet.CLASS.IN,
        ttl: 300,
        address: '127.0.0.1'
      });
    }

    send(response);
  }

  parseDomainParts(name) {
    const domainParts = name.split('.');
    const topDomain = domainParts.slice(-2).join('.');
    const subdomain = domainParts.slice(0, -2).join('.') || '@';

    return { topDomain, subdomain };
  }

  async lookupDnsRecords(domain, subdomain) {
    console.log(`Looking up ${subdomain} for domain ${domain}`);

    try {
      // Find customer with this domain
      const email = `dns@${domain}`;
      const customers = await stripe.customers.list({
        limit: 1,
        email: email
      });

      if (customers.data.length === 0) {
        console.log(`No customer found for domain ${domain}`);
        return null;
      }

      try {
        console.log(customers.data[0].metadata);
        const dnsRecords = JSON.parse(customers.data[0].metadata.dns_records || '{}');

        // Check for exact match
        let recordSet = dnsRecords[subdomain];

        // Check for wildcard if no exact match
        if (!recordSet && subdomain !== '@') {
          recordSet = dnsRecords['*'];
        }

        return recordSet || null;
      } catch (e) {
        console.error('Error parsing DNS records:', e);
        return null;
      }
    } catch (error) {
      console.error('Stripe search error:', error);
      return null;
    }
  }

  addRecord(response, name, type, record) {
    response.answers.push({
        name,
        type,
        class: Packet.CLASS.IN,
        ttl: 300,
        ...record,
    });
  }

  addRecordsToResponse(response, name, recordSet, type) {
    switch (type) {
        case Packet.TYPE.A:
            if (recordSet.A) {
                recordSet.A.forEach(ip => {
                    console.log(`Adding A record: ${ip}`);
                    this.addRecord(response, name, Packet.TYPE.A, { address: ip });
                });
                return true;
            } else if (recordSet.CNAME) {
                console.log(`Adding CNAME record: ${recordSet.CNAME[0]}`);
                this.addRecord(response, name, Packet.TYPE.CNAME, { domain: recordSet.CNAME[0] });
                return true;
            }
            break;
        case Packet.TYPE.CNAME:
            if (recordSet.CNAME) {
                console.log(`Adding CNAME record: ${recordSet.CNAME[0]}`);
                this.addRecord(response, name, Packet.TYPE.CNAME, { domain: recordSet.CNAME[0] });
                return true;
            }
            break;
        case Packet.TYPE.MX:
            const mxRecords = recordSet.MX || [];
            mxRecords.forEach(mx => {
                console.log(`Adding MX record: ${mx.exchange} (preference: ${mx.priority})`);
                this.addRecord(response, name, Packet.TYPE.MX, {
                    priority: mx.priority,
                    exchange: mx.exchange
                });
            });
            return mxRecords.length > 0;
    }
    return false;
  }

  start() {
    this.server.on('request', (request, response, rinfo) => {
      const question = request.questions[0];
      console.log(`DNS Query: ${question.name} (Type: ${question.type})`);
    });

    this.server.on('requestError', (error) => {
      console.log('Client sent an invalid request', error);
    });

    this.server.on('listening', () => {
      console.log('Stripe DNS Server listening on:');
      console.log(this.server.addresses());
    });

    this.server.on('close', () => {
      console.log('Server closed');
    });

    this.server.listen({
      udp: {
        port: this.port,
        address: this.address,
        type: "udp4",
      },
      tcp: {
        port: this.port,
        address: this.address,
      },
    });

    return this;
  }

  stop() {
    if (this.server) {
      this.server.close();
    }
  }
}

// Create and start the server
const dnsServer = new StripeDnsServer({
  port: process.env.DNS_PORT || 5333
}).start();

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down server...');
  dnsServer.stop();
  process.exit(0);
});
