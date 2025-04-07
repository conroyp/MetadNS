require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Usage: node dns-update.js example.com www A 192.168.1.1
//        node dns-update.js example.com @ A 192.168.1.2,192.168.1.3
//        node dns-update.js example.com blog CNAME blog.example.net.

async function updateDNSRecord(domain, subdomain, recordType, value) {
  try {
    // Find customer with this domain
    const email = `dns@${domain}`;
    console.log('Searching for customer with email:', email);
    const customers = await stripe.customers.list({
      limit: 1,
      email: email
    });

    let customer;
    let dnsRecords = {};

    if (customers.data.length > 0) {
      // Customer exists, get current records
      customer = customers.data[0];
      try {
        dnsRecords = JSON.parse(customer.metadata.dns_records || '{}');
      } catch (e) {
        console.error('Error parsing existing DNS records, starting fresh');
      }
    } else {
      // Create new customer for this domain
      console.log(`Creating new customer for domain ${domain}...`);
      customer = await stripe.customers.create({
        email: `dns@${domain}`,
        name: `DNS records for ${domain}`,
      });
    }

    // Format the subdomain (use @ for root)
    const sub = subdomain === '@' || subdomain === '' ? '@' : subdomain;

    // Process the value based on record type
    let formattedValue;
    if (recordType === 'A' || recordType === 'CNAME') {
      // For A records, allow comma-separated IPs
      formattedValue = value.split(',').map(v => v.trim());
    } else if (recordType === 'MX') {
      // For MX records, format is "priority exchange"
      formattedValue = value.split(',').map(v => {
        const [priority, exchange] = v.trim().split(' ');
        return {
          priority: parseInt(priority, 10),
          exchange: exchange.endsWith('.') ? exchange : `${exchange}.`
        };
      });
    }

    // Update records
    if (!dnsRecords[sub]) {
      dnsRecords[sub] = {};
    }
    dnsRecords[sub][recordType] = formattedValue;

    // Save back to Stripe
    await stripe.customers.update(customer.id, {
      metadata: {
        dns_domain: domain,
        dns_records: JSON.stringify(dnsRecords)
      }
    });

    console.log(`✅ Updated ${recordType} record for ${sub}.${domain}`);
    console.log(`Value: ${JSON.stringify(formattedValue)}`);

  } catch (error) {
    console.error('Error updating DNS record:', error.message);
  }
}


const args = process.argv.slice(2);
if (args.length < 4) {
  console.log('Usage: node dns-update.js <domain> <subdomain> <recordType> <value>');
  console.log('Examples:');
  console.log('  node dns-update.js example.com www A 192.168.1.1');
  console.log('  node dns-update.js example.com @ A 192.168.1.2,192.168.1.3');
  console.log('  node dns-update.js example.com blog CNAME blog.example.net.');
  console.log('  node dns-update.js example.com @ MX "10 mail1.example.com.,20 mail2.example.com."');
  process.exit(1);
}

const [domain, subdomain, recordType, value] = args;
updateDNSRecord(domain, subdomain, recordType, value);
